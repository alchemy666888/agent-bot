import "server-only";

import { randomUUID, createHash } from "node:crypto";
import {
  safeErrorSchema,
  workerRequestSchema,
  workerResponseSchema,
  type WorkerRequest,
  type WorkerResponse,
} from "../../shared/contracts";
import { logException, logStructured } from "../../shared/logger";
import { sanitizeProgress } from "../../shared/worker-progress";
import type { SandboxHandle } from "./sdk-adapter";
import { WORKER_COMMAND_TIMEOUT_MS } from "../../shared/worker-budget";

const RUNTIME_ROOT = "/tmp/telegram-agent";

export function workerProgressPath(correlationId: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(correlationId))
    throw new Error("PERSISTENCE_PATH_REJECTED");
  return `${RUNTIME_ROOT}/progress/${correlationId}.json`;
}

export { WORKER_COMMAND_TIMEOUT_MS };

const commandFailureCodes: ReadonlyArray<[RegExp, string]> = [
  [/WORKER_COMMAND_TIMEOUT/, "WORKER_COMMAND_TIMEOUT"],
  [/command timed out/i, "WORKER_COMMAND_TIMEOUT"],
  [/Dynamic require of .+ is not supported/i, "WORKER_BUNDLE_INCOMPATIBLE"],
  [
    /ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)/i,
    "WORKER_MODULE_MISSING",
  ],
  [/WORKER_CONFIGURATION_INVALID/, "WORKER_CONFIGURATION_INVALID"],
  [/password authentication failed/i, "DATABASE_AUTHENTICATION_FAILED"],
  [
    /self[- ]signed certificate|certificate has expired|unable to verify/i,
    "DATABASE_TLS_FAILED",
  ],
  [/ECONNREFUSED/, "DATABASE_CONNECTION_REFUSED"],
  [/ENETUNREACH/, "DATABASE_NETWORK_UNREACHABLE"],
  [/ENOTFOUND|getaddrinfo/i, "DATABASE_HOST_NOT_FOUND"],
  [
    /ETIMEDOUT|connection terminated|timeout expired/i,
    "DATABASE_CONNECTION_FAILED",
  ],
];

async function commandFailureCode(result: {
  stderr(): Promise<string>;
}): Promise<string> {
  // Never forward command output: it can contain request data or secrets.
  const stderr = await result.stderr().catch(() => "");
  return (
    commandFailureCodes.find(([pattern]) => pattern.test(stderr))?.[1] ??
    "WORKER_COMMAND_FAILED"
  );
}

export const workerBundlePath = (source: Buffer) =>
  `${RUNTIME_ROOT}/worker-${createHash("sha256").update(source).digest("hex")}.mjs`;

export async function installWorker(
  sandbox: SandboxHandle,
  source: Buffer,
): Promise<string> {
  const path = workerBundlePath(source);
  const probe = await sandbox.runCommand("test", ["-f", path]);
  if (probe.exitCode !== 0)
    await sandbox.writeFiles([{ path, content: source }]);
  return path;
}

export async function invokeWorker(
  sandbox: SandboxHandle,
  workerPath: string,
  request: WorkerRequest,
  env: Record<string, string> = {},
): Promise<WorkerResponse> {
  const valid = workerRequestSchema.parse(request);
  const nonce = randomUUID();
  const requestPath = `${RUNTIME_ROOT}/requests/${nonce}.json`;
  const responsePath = `${RUNTIME_ROOT}/responses/${nonce}.json`;
  const progressPath = workerProgressPath(valid.correlationId);
  try {
    await sandbox.writeFiles([
      { path: requestPath, content: Buffer.from(JSON.stringify(valid)) },
      {
        path: progressPath,
        content: Buffer.from(
          JSON.stringify({ stage: "command", elapsedMs: 0 }),
        ),
      },
    ]);
    // The SDK positional form keeps only signal and timeout. Operation
    // secrets must use the object form or they never reach the worker.
    const result = await sandbox.runCommand({
      cmd: "node",
      args: [workerPath, valid.operation, requestPath, responsePath],
      env: { ...env, WORKER_PROGRESS_FILE: progressPath },
      timeoutMs: WORKER_COMMAND_TIMEOUT_MS,
    });
    const stderr = await result.stderr().catch((error: unknown) => {
      logException(error, { correlationId: valid.correlationId, component: "controller", operation: valid.operation, stage: "worker-diagnostics" });
      return "";
    });
    forwardWorkerDiagnostics(stderr, valid);
    if (result.exitCode !== 0) {
      const code = await commandFailureCode({ stderr: async () => stderr });
      const progress = await readCommandProgress(sandbox, progressPath);
      throw Object.assign(new Error(code), {
        operation: valid.operation,
        ...(code === "WORKER_COMMAND_TIMEOUT"
          ? { timeoutLimitMs: WORKER_COMMAND_TIMEOUT_MS }
          : {}),
        ...(progress ? { progress } : {}),
      });
    }
    const response = await sandbox.readFileToBuffer({ path: responsePath });
    if (!response) throw new Error("WORKER_RESPONSE_MISSING");
    const parsed = workerResponseSchema.parse(JSON.parse(response.toString("utf8")));
    if (!parsed.ok) logStructured({
      correlationId: valid.correlationId,
      component: "worker",
      operation: valid.operation,
      stage: "worker-response",
      result: "failure",
      code: parsed.error?.code ?? "WORKER_FAILED",
      metadata: { error: parsed.error },
    });
    return parsed;
  } finally {
    // Cleanup runs after the worker result is known. A dead session throws a
    // plain Error here and would otherwise replace that result, which the
    // controller logs as SANDBOX_UNAVAILABLE and runs the turn again locally.
    await sandbox
      .runCommand("rm", ["-f", requestPath, responsePath, progressPath])
      .catch((error: unknown) => {
        logException(error, { correlationId: valid.correlationId, component: "controller", operation: valid.operation, stage: "worker-cleanup" });
      });
  }
}

async function readCommandProgress(
  sandbox: SandboxHandle,
  path: string,
): Promise<ReturnType<typeof sanitizeProgress>> {
  const buffer = await sandbox.readFileToBuffer({ path }).catch(() => null);
  if (!buffer) return undefined;
  try {
    return sanitizeProgress(JSON.parse(buffer.toString("utf8")));
  } catch {
    return undefined;
  }
}

export async function streamSandboxFile(
  sandbox: SandboxHandle,
  path: string,
): Promise<NodeJS.ReadableStream> {
  const stream = await sandbox.readFile({ path });
  if (!stream) throw new Error("SANDBOX_FILE_MISSING");
  return stream;
}

/** Subprocess console output is not a Vercel Function log. Forward only validated error envelopes. */
function forwardWorkerDiagnostics(stderr: string, request: WorkerRequest): void {
  for (const line of stderr.slice(-32_768).split("\n").slice(-16)) {
    let entry: { component?: unknown; result?: unknown; metadata?: { error?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || entry.component !== "worker" || entry.result !== "failure") continue;
    const parsed = safeErrorSchema.safeParse(entry.metadata?.error);
    if (!parsed.success) continue;
    logStructured({
      correlationId: request.correlationId,
      component: "worker",
      operation: request.operation,
      stage: "worker-diagnostic",
      result: "failure",
      code: parsed.data.code,
      metadata: { error: parsed.data },
    });
  }
}
