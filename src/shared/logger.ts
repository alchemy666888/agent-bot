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

/** Emits one sanitized JSON object. Callers must pass metadata, never raw bodies. */
export function logStructured(
  record: LogRecord,
  sink: (line: string) => void = console.info,
): void {
  sink(
    JSON.stringify(redact({ timestamp: new Date().toISOString(), ...record })),
  );
}

export function safeError(
  error: unknown,
  fallbackCode = "INTERNAL_ERROR",
): {
  code: string;
  classification: "transient" | "permanent" | "internal";
  message: string;
} {
  const status = (error as { status?: unknown })?.status;
  const candidate = error instanceof Error ? error.message : fallbackCode;
  const code = /^[A-Z][A-Z0-9_]*$/.test(candidate) ? candidate : fallbackCode;
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
  };
}
