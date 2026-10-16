import "server-only";

import { tmpdir } from "node:os";
import { join } from "node:path";
import { uuidV7 } from "../../shared/ids";
import { logStructured, safeError } from "../../shared/logger";
import type { WorkerRequest, WorkerResponse } from "../../shared/contracts";
import { createLocalSandboxSdk } from "./local-adapter";
import { isStaleSnapshotError } from "./provider-error";
import type { SandboxHandle } from "./sdk-adapter";
import { installWorker, invokeWorker } from "./transport";

const LOCAL_FALLBACK_CODES = new Set([
  "SANDBOX_UNAVAILABLE",
  "INTERNAL_ERROR",
  "WORKER_COMMAND_FAILED",
  "WORKER_RESPONSE_MISSING",
  "WORKER_MODULE_MISSING",
  "WORKER_BUNDLE_INCOMPATIBLE",
  "WORKER_CONFIGURATION_INVALID",
  "DATABASE_NETWORK_UNREACHABLE",
  "DATABASE_HOST_NOT_FOUND",
  "DATABASE_CONNECTION_REFUSED",
  "DATABASE_CONNECTION_FAILED",
  "DATABASE_TLS_FAILED",
  "DATABASE_AUTHENTICATION_FAILED",
]);

export function sandboxFailureCanRunLocally(error: unknown): boolean {
  return LOCAL_FALLBACK_CODES.has(
    safeError(error, "SANDBOX_UNAVAILABLE", "sandbox").code,
  );
}

function persistenceBlocked(response: WorkerResponse): boolean {
  return (
    !response.ok && response.error?.diagnostic?.stage === "persistence-sync"
  );
}

/** Runs the worker on this server when the sandbox cannot execute it. */
export function localWorkerSandbox(name: string): Promise<SandboxHandle> {
  return createLocalSandboxSdk(
    join(tmpdir(), "telegram-agent-local"),
  ).getOrCreateSandbox({
    name,
    region: "sin1",
    persistent: true,
    resume: true,
    timeout: 45 * 60 * 1000,
    keepLastSnapshots: { count: 1 },
  });
}

export async function executeWorker(input: {
  correlationId?: string;
  source: Buffer;
  request: WorkerRequest;
  env: Record<string, string>;
  openSandbox: () => Promise<SandboxHandle>;
  resetSandbox?: () => Promise<SandboxHandle>;
  openLocal?: () => Promise<SandboxHandle>;
}): Promise<WorkerResponse> {
  const correlationId = input.correlationId ?? uuidV7();
  const run = async (sandbox: SandboxHandle) => {
    const workerPath = await installWorker(sandbox, input.source);
    return invokeWorker(sandbox, workerPath, input.request, input.env);
  };
  const locally = async (code: string, error?: unknown) => {
    const recorded = error
      ? safeError(error, "SANDBOX_UNAVAILABLE", "sandbox")
      : undefined;
    logStructured({
      correlationId,
      component: "controller",
      operation: "sandbox.local_fallback",
      stage: "sandbox",
      result: "degraded",
      code,
      ...(recorded?.diagnostic ? { metadata: recorded.diagnostic } : {}),
    });
    return run(
      await (input.openLocal ?? (() => localWorkerSandbox("local")))(),
    );
  };
  const replaced = async (error: unknown) => {
    if (!input.resetSandbox || !isStaleSnapshotError(error)) return undefined;
    try {
      const response = await run(await input.resetSandbox());
      if (!persistenceBlocked(response)) return response;
      return locally(response.error?.code ?? "SANDBOX_UNAVAILABLE");
    } catch (retryError) {
      if (!sandboxFailureCanRunLocally(retryError)) throw retryError;
      return locally(
        safeError(retryError, "SANDBOX_UNAVAILABLE", "sandbox").code,
        retryError,
      );
    }
  };
  try {
    const response = await run(await input.openSandbox());
    if (!persistenceBlocked(response)) return response;
    return locally(response.error?.code ?? "SANDBOX_UNAVAILABLE");
  } catch (error) {
    const recovered = await replaced(error);
    if (recovered) return recovered;
    if (!sandboxFailureCanRunLocally(error)) throw error;
    return locally(
      safeError(error, "SANDBOX_UNAVAILABLE", "sandbox").code,
      error,
    );
  }
}
