import { ZodError } from "zod";
import { redact, redactText } from "./redaction";
import type { FailureContext } from "./worker-progress";

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
  sink?: (line: string) => void,
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
  sink?: (line: string) => void,
): string {
  const level =
    record.result === "failure"
      ? "error"
      : record.result === "retry" || record.result === "degraded"
        ? "warning"
        : "info";
  const line = JSON.stringify(
    redact({ timestamp: new Date().toISOString(), ...record, level }),
  );
  const output =
    sink ??
    (level === "error"
      ? console.error
      : level === "warning"
        ? console.warn
        : console.info);
  output(line);
  return line;
}

/** Log at the boundary before recovering or returning a safe response. */
export function logException(
  error: unknown,
  context: Omit<LogRecord, "result">,
  sink?: (line: string) => void,
): string {
  const failure = safeError(
    error,
    context.code ?? "INTERNAL_ERROR",
    context.stage,
  );
  return logStructured(
    {
      ...context,
      result: "failure",
      code: failure.code,
      metadata: {
        ...context.metadata,
        error: failure,
        causes: exceptionCauses(error),
      },
    },
    sink,
  );
}

/** Only diagnostic fields are copied; request bodies and arbitrary Error properties are excluded. */
function exceptionCauses(error: unknown): Record<string, unknown>[] {
  const seen = new Set<unknown>();
  const nodes: Record<string, unknown>[] = [];
  const visit = (value: unknown, path: string, depth: number) => {
    if (value == null || seen.has(value) || depth > 8 || nodes.length >= 8)
      return;
    seen.add(value);
    const record =
      typeof value === "object"
        ? (value as Record<string, unknown>)
        : undefined;
    const message =
      value instanceof ZodError
        ? "validation failed"
        : value instanceof Error
          ? value.message
          : typeof value === "string"
            ? value
            : "Non-Error exception";
    nodes.push({
      path,
      kind:
        value instanceof Error ? redactText(value.name, 64) : "UnknownError",
      message: redactText(message, 400),
      ...(record ? { annotations: errorAnnotations(record) } : {}),
      trace: ownErrorTrace(value).slice(0, 3),
    });
    if (record) {
      visit(record.cause, `${path}.cause`, depth + 1);
      if (Array.isArray(record.errors))
        record.errors
          .slice(0, 3)
          .forEach((item, index) =>
            visit(item, `${path}.errors[${index}]`, depth + 1),
          );
    }
  };
  visit(error, "error", 0);
  return nodes;
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
  detail?: string;
  trace?: string[];
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
      "WORKER_COMMAND_TIMEOUT",
      "PROVIDER_REQUEST_TIMEOUT",
    ].includes(code);
  const detail = errorDetail(error);
  const trace = errorTrace(error);
  return {
    code,
    classification: transient
      ? "transient"
      : error instanceof Error
        ? "permanent"
        : "internal",
    message: transient ? "Temporary operation failure" : "Operation failed",
    ...(detail ? { detail } : {}),
    ...(trace.length ? { trace } : {}),
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

const DETAIL_LIMIT = 1800;
const TRACE_LIMIT = 10;

function errorAnnotations(error: object): string {
  const record = error as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ["code", "errno", "syscall"] as const) {
    const value = record[key];
    if (typeof value === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(value))
      parts.push(`${key}=${value}`);
    else if (typeof value === "number" && Number.isInteger(value))
      parts.push(`${key}=${value}`);
  }
  const status = record.status ?? record.statusCode;
  if (typeof status === "number" && status >= 100 && status <= 599)
    parts.push(`status=${status}`);
  if (typeof record.providerDetail === "string" && record.providerDetail.trim())
    parts.push(`provider=${redactText(record.providerDetail, 400)}`);
  return parts.join(" ");
}

function errorChain(error: unknown, depth = 0): string[] {
  if (depth > 5 || error == null) return [];
  if (typeof error === "string") return [redactText(error, 400)];
  if (typeof error !== "object") return [redactText(String(error), 200)];
  const name =
    error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name)
      ? error.name
      : "UnknownError";
  const message =
    error instanceof ZodError
      ? "configuration validation failed"
      : error instanceof Error
        ? redactText(error.message, 400)
        : "";
  const notes = errorAnnotations(error);
  const line = [`${name}${notes ? ` (${notes})` : ""}`, message]
    .filter(Boolean)
    .join(": ");
  const cause = (error as { cause?: unknown }).cause;
  const nested = Array.isArray((error as { errors?: unknown }).errors)
    ? (error as { errors: unknown[] }).errors.slice(0, 3)
    : [];
  return [
    line,
    ...errorChain(cause, depth + 1),
    ...nested.flatMap((item) => errorChain(item, depth + 1)),
  ];
}

function errorDetail(error: unknown): string | undefined {
  const chain = errorChain(error);
  const lines =
    chain.length > 1
      ? [`Root cause: ${chain.at(-1)}`, "Error chain:", ...chain]
      : chain;
  const detail = lines.join("\n").slice(0, DETAIL_LIMIT);
  return detail || undefined;
}

function errorTrace(error: unknown): string[] {
  const seen = new Set<unknown>();
  const collect = (value: unknown, depth: number): string[] => {
    if (!value || seen.has(value) || depth > 8) return [];
    seen.add(value);
    const record =
      typeof value === "object"
        ? (value as Record<string, unknown>)
        : undefined;
    const nested =
      record && Array.isArray(record.errors) ? record.errors.slice(0, 3) : [];
    return [
      ...(record ? collect(record.cause, depth + 1) : []),
      ...nested.flatMap((item) => collect(item, depth + 1)),
      ...ownErrorTrace(value),
    ].slice(0, TRACE_LIMIT);
  };
  return collect(error, 0);
}

/** File names and line numbers only. Absolute paths can contain home directories. */
function ownErrorTrace(error: unknown): string[] {
  if (!(error instanceof Error) || typeof error.stack !== "string") return [];
  const frames: string[] = [];
  for (const raw of error.stack.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("at ")) continue;
    const shortened = trimmed
      .replace(/\((?:file:\/\/)?(?:\/|[A-Za-z]:\\)[^)]+\)/g, (match) => {
        const inner = match.slice(1, -1);
        return `(${inner.split(/[/\\]/).pop() ?? "unknown"})`;
      })
      .replace(
        /(?:file:\/\/)?(?:\/|[A-Za-z]:\\)\S+/g,
        (match) => match.split(/[/\\]/).pop() ?? "unknown",
      );
    const cleaned = redactText(shortened, 180);
    if (cleaned.startsWith("at ")) frames.push(cleaned);
  }
  const application = frames.filter(
    (frame) => !/node_modules|node:|<anonymous>/.test(frame),
  );
  const selected = application.length ? application : frames;
  return selected.slice(0, TRACE_LIMIT);
}

export function formatFailureDebug(input: {
  headline: string;
  correlationId: string;
  durationMs: number;
  source: string;
  updateId?: string;
  inputKind?: string;
  context?: FailureContext;
  failure: {
    code: string;
    classification: string;
    message: string;
    detail?: string;
    trace?: string[];
    diagnostic?: {
      stage?: string;
      kind?: string;
      causeCode?: string;
      status?: number;
      issues?: string[];
    };
  };
}): string {
  const diagnostic = input.failure.diagnostic;
  const lines = [
    input.headline,
    "",
    "debug",
    `correlationId: ${input.correlationId}`,
    ...(input.updateId ? [`updateId: ${input.updateId}`] : []),
    ...(input.inputKind ? [`inputKind: ${input.inputKind}`] : []),
    `durationMs: ${input.durationMs}`,
    `source: ${input.source}`,
    `code: ${input.failure.code}`,
    `classification: ${input.failure.classification}`,
    `message: ${input.failure.message}`,
    ...(input.context?.operation
      ? [`operation: ${input.context.operation}`]
      : []),
    ...(input.context?.timeoutLimitMs === undefined
      ? []
      : [`timeoutLimitMs: ${input.context.timeoutLimitMs}`]),
    ...(input.context?.progress
      ? [
          `workerStage: ${input.context.progress.stage}`,
          `workerElapsedMs: ${input.context.progress.elapsedMs}`,
          ...(input.context.progress.attempt === undefined
            ? []
            : [`attempt: ${input.context.progress.attempt}`]),
          ...(input.context.progress.iteration === undefined
            ? []
            : [`iteration: ${input.context.progress.iteration}`]),
          ...(input.context.progress.executionMode
            ? [`executionMode: ${input.context.progress.executionMode}`]
            : []),
          ...(input.context.progress.tool
            ? [`tool: ${input.context.progress.tool}`]
            : []),
        ]
      : []),
    ...(diagnostic?.stage ? [`stage: ${diagnostic.stage}`] : []),
    ...(diagnostic?.kind ? [`kind: ${diagnostic.kind}`] : []),
    ...(diagnostic?.causeCode ? [`causeCode: ${diagnostic.causeCode}`] : []),
    ...(typeof diagnostic?.status === "number"
      ? [`status: ${diagnostic.status}`]
      : []),
    ...(diagnostic?.issues?.length
      ? [`issues: ${diagnostic.issues.join(", ")}`]
      : []),
    ...(input.failure.detail ? ["detail:", input.failure.detail] : []),
    ...(input.failure.trace?.length ? ["trace:", ...input.failure.trace] : []),
  ];
  return redactText(lines.join("\n"), 3900);
}
