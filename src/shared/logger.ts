import { ZodError } from "zod";
import { redact } from "./redaction";

export type LogResult = "success" | "failure" | "retry" | "degraded";
export interface LogRecord {
  correlationId: string;
  component: "controller" | "worker";
  operation: string;
  stage: string;
  result: LogResult;
  durationMs?: number;
  code?: string;
  metadata?: Record<string, unknown>;
}

export type SecurityAuditAction =
  | "skill.draft.created"
  | "skill.draft.revised"
  | "skill.approved"
  | "skill.installed"
  | "skill.invoked"
  | "skill.authorization_denied"
  | "telegram.update.replayed";

/** Audit input is constrained to codes/identifiers and always takes the redaction path. */
export function logSecurityAudit(
  event: {
    correlationId: string;
    action: SecurityAuditAction;
    result: "success" | "denied";
    actorTelegramUserId?: string;
    code?: string;
    metadata?: Record<string, unknown>;
  },
  sink: (line: string) => void = console.info,
): string {
  return logStructured(
    {
      correlationId: event.correlationId,
      component: "worker",
      operation: event.action,
      stage: "authorization",
      result: event.result === "success" ? "success" : "failure",
      ...(event.code && /^[A-Z][A-Z0-9_]{0,63}$/.test(event.code)
        ? { code: event.code }
        : {}),
      metadata: {
        ...(event.actorTelegramUserId
          ? {
              actorTelegramUserId: /^\d+$/.test(event.actorTelegramUserId)
                ? event.actorTelegramUserId
                : "invalid",
            }
          : {}),
        ...event.metadata,
      },
    },
    sink,
  );
}

/** Emits one bounded, redacted JSON object. Callers must never pass raw bodies. */
export function logStructured(
  record: LogRecord,
  sink: (line: string) => void = console.info,
): string {
  const line = JSON.stringify(
    redact({ timestamp: new Date().toISOString(), ...record }),
  );
  sink(line);
  return line;
}

/** Field paths and parser codes only. Values are never copied from the error. */
export function configurationIssues(error: unknown): string[] | undefined {
  if (!(error instanceof ZodError)) return undefined;
  const issues = error.issues.slice(0, 8).flatMap((issue) => {
    const path = issue.path
      .map((part) => String(part))
      .filter((part) => /^[A-Za-z0-9_]+$/.test(part))
      .join(".");
    return path && /^[a-z0-9_]{1,40}$/.test(issue.code)
      ? [`${path}:${issue.code}`]
      : [];
  });
  return issues.length ? issues : ["environment:invalid"];
}

export function safeError(
  error: unknown,
  fallbackCode = "INTERNAL_ERROR",
  stage?: string,
): {
  code: string;
  classification: "transient" | "permanent" | "internal";
  message: string;
  diagnostic?: {
    stage: string;
    kind: string;
    causeCode?: string;
    status?: number;
    issues?: string[];
  };
} {
  const status = (error as { status?: unknown })?.status;
  const rawCauseCode =
    (error as { code?: unknown })?.code ??
    (error as { cause?: { code?: unknown } })?.cause?.code;
  const causeCode =
    typeof rawCauseCode === "string" &&
    /^[A-Za-z0-9_.-]{1,64}$/.test(rawCauseCode)
      ? rawCauseCode
      : undefined;
  const kind =
    error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name)
      ? error.name
      : "UnknownError";
  const issues = configurationIssues(error);
  const candidate = error instanceof Error ? error.message : fallbackCode;
  const code = issues
    ? "CONFIGURATION_INVALID"
    : stage === "persistence-sync" &&
        ["ENETUNREACH", "ENOTFOUND"].includes(causeCode ?? "")
      ? causeCode === "ENOTFOUND"
        ? "DATABASE_HOST_NOT_FOUND"
        : "DATABASE_NETWORK_UNREACHABLE"
      : /^[A-Z][A-Z0-9_]*$/.test(candidate)
        ? candidate
        : fallbackCode;
  const transient =
    status === 408 ||
    status === 409 ||
    status === 429 ||
    (typeof status === "number" && status >= 500) ||
    [
      "LOCK_TIMEOUT",
      "TELEGRAM_DELIVERY_FAILED",
      "DEEPSEEK_REQUEST_FAILED",
    ].includes(code);
  return {
    code,
    classification: transient
      ? "transient"
      : error instanceof Error
        ? "permanent"
        : "internal",
    message: transient ? "Temporary operation failure" : "Operation failed",
    ...(stage
      ? {
          diagnostic: {
            stage,
            kind,
            ...(causeCode ? { causeCode } : {}),
            ...(typeof status === "number" && status >= 100 && status <= 599
              ? { status }
              : {}),
            ...(issues ? { issues } : {}),
          },
        }
      : {}),
  };
}
