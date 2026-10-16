const STAGE = /^[a-z][a-z0-9-]{0,63}$/;
const MODE = /^[a-z][a-z0-9_]{0,63}$/;
const TOOL = /^[a-z][a-z0-9_-]{0,63}$/;
const OPERATION = /^(?:telegramTurn|query|export|recover|health)$/;

export type WorkerProgress = {
  stage: string;
  elapsedMs: number;
  attempt?: number;
  iteration?: number;
  executionMode?: string;
  tool?: string;
};

export type FailureContext = {
  operation?: string;
  timeoutLimitMs?: number;
  progress?: WorkerProgress;
};

function boundedCount(value: unknown, maximum: number): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= maximum
    ? value
    : undefined;
}

/** Allowlisted counters only. User text and provider payloads never qualify. */
export function sanitizeProgress(value: unknown): WorkerProgress | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.stage !== "string" || !STAGE.test(record.stage))
    return undefined;
  const elapsedMs = boundedCount(record.elapsedMs, 3_600_000);
  if (elapsedMs === undefined) return undefined;
  const attempt = boundedCount(record.attempt, 20);
  const iteration = boundedCount(record.iteration, 20);
  const executionMode =
    typeof record.executionMode === "string" && MODE.test(record.executionMode)
      ? record.executionMode
      : undefined;
  const tool =
    typeof record.tool === "string" && TOOL.test(record.tool)
      ? record.tool
      : undefined;
  return {
    stage: record.stage,
    elapsedMs,
    ...(attempt === undefined ? {} : { attempt }),
    ...(iteration === undefined ? {} : { iteration }),
    ...(executionMode ? { executionMode } : {}),
    ...(tool ? { tool } : {}),
  };
}

/** Fields copied from a command failure. Anything else on the error is dropped. */
export function failureContext(error: unknown): FailureContext | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  const operation =
    typeof record.operation === "string" && OPERATION.test(record.operation)
      ? record.operation
      : undefined;
  const timeoutLimitMs =
    typeof record.timeoutLimitMs === "number" &&
    Number.isInteger(record.timeoutLimitMs) &&
    record.timeoutLimitMs > 0 &&
    record.timeoutLimitMs <= 3_600_000
      ? record.timeoutLimitMs
      : undefined;
  const progress = sanitizeProgress(record.progress);
  if (!operation && timeoutLimitMs === undefined && !progress) return undefined;
  return {
    ...(operation ? { operation } : {}),
    ...(timeoutLimitMs === undefined ? {} : { timeoutLimitMs }),
    ...(progress ? { progress } : {}),
  };
}
