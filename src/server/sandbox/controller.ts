import "server-only";

import { uuidV7 } from "../../shared/ids";
import { logStructured, safeError } from "../../shared/logger";
import type { SandboxConfig } from "../config";
import { createLocalSandboxSdk } from "./local-adapter";
import {
  vercelSandboxSdk,
  type SandboxHandle,
  type SandboxSdk,
} from "./sdk-adapter";

export function selectSandboxSdk(
  env: Record<string, string | undefined> = process.env,
): SandboxSdk {
  const root = env.TELEGRAM_AGENT_LOCAL_ROOT;
  if (root && !env.VERCEL) return createLocalSandboxSdk(root);
  return vercelSandboxSdk;
}

export const HOBBY_SANDBOX_TIMEOUT_MS = 45 * 60 * 1000;

const PROVIDER_CODE = /^[A-Za-z0-9_.-]{1,64}$/;
const APPLICATION_CODE = /^[A-Z][A-Z0-9_]*$/;

/** SDK session getters throw this before runCommand/writeFiles would resume. */
function missingSession(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message ===
      "No active session. Run a command or call resume first." ||
      error.message === "No active session to stop.")
  );
}

/**
 * APIError keeps its HTTP status on response and its provider code on json.
 * Copy both onto the Error so safeError can record them without a logger change.
 */
function translateSandboxError(error: unknown): Error {
  if (
    error instanceof Error &&
    APPLICATION_CODE.test(error.message) &&
    typeof (error as { status?: unknown }).status === "number"
  )
    return error;
  const status = (error as { response?: { status?: unknown } })?.response
    ?.status;
  const raw = (error as { json?: { error?: { code?: unknown } } })?.json?.error
    ?.code;
  const providerCode =
    typeof raw === "string" && PROVIDER_CODE.test(raw) ? raw : undefined;
  const message =
    providerCode && APPLICATION_CODE.test(providerCode)
      ? providerCode
      : "SANDBOX_UNAVAILABLE";
  return Object.assign(new Error(message), {
    code: providerCode ?? "SANDBOX_UNAVAILABLE",
    ...(typeof status === "number" && status >= 100 && status <= 599
      ? { status }
      : {}),
  });
}

async function sandboxCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw translateSandboxError(error);
  }
}

function degradeReconcile(error: unknown, correlationId?: string) {
  const failure = translateSandboxError(error);
  const recorded = safeError(failure, "SANDBOX_UNAVAILABLE", "sandbox");
  logStructured({
    correlationId: correlationId ?? uuidV7(),
    component: "controller",
    operation: "sandbox.reconcile",
    stage: "sandbox",
    result: "degraded",
    code: "SANDBOX_UNAVAILABLE",
    ...(recorded.diagnostic ? { metadata: recorded.diagnostic } : {}),
  });
}

function readRoutes(sandbox: SandboxHandle): unknown {
  try {
    return (sandbox as { routes?: unknown }).routes;
  } catch (error) {
    if (missingSession(error)) return [];
    throw translateSandboxError(error);
  }
}

function readStatus(sandbox: SandboxHandle): string | undefined {
  try {
    return sandbox.status;
  } catch (error) {
    if (missingSession(error)) return undefined;
    throw translateSandboxError(error);
  }
}

export async function ensureSandbox(
  config: SandboxConfig,
  sdk?: SandboxSdk,
  correlationId?: string,
): Promise<SandboxHandle> {
  const resolved = sdk ?? selectSandboxSdk();
  const sandbox = await sandboxCall(() =>
    resolved.getOrCreateSandbox({
      name: config.SANDBOX_NAME,
      region: "sin1",
      persistent: true,
      resume: true,
      timeout: HOBBY_SANDBOX_TIMEOUT_MS,
      keepLastSnapshots: { count: 1 },
    }),
  );
  const routes = readRoutes(sandbox);
  if (sandbox.name !== config.SANDBOX_NAME)
    throw new Error("SANDBOX_CONFIGURATION_MISMATCH");

  // getOrCreate applies creation options only to a new named sandbox. Reconcile
  // an existing sandbox as well, otherwise a sandbox first created in the SDK's
  // default region (iad1) is returned forever and every request fails below.
  const regionMismatch = sandbox.region !== config.region;
  const hasPublicRoutes = Array.isArray(routes) && routes.length > 0;
  if (regionMismatch || hasPublicRoutes) {
    try {
      await sandbox.update({
        persistent: true,
        region: config.region,
        failoverRegions: [],
        ports: [],
        timeout: HOBBY_SANDBOX_TIMEOUT_MS,
        keepLastSnapshots: { count: 1 },
      });
    } catch (error) {
      // A rejected region or port change must not discard a sandbox the next
      // command can still resume.
      degradeReconcile(error, correlationId);
      return sandbox;
    }
    // Region changes apply to the next session. Stop the old session so the
    // first worker command resumes it in sin1 rather than continuing in iad1.
    // A missing session is already stopped; the next command resumes it.
    const status = readStatus(sandbox);
    if (regionMismatch && status !== undefined && status !== "stopped") {
      try {
        await sandbox.stop();
      } catch (error) {
        if (!missingSession(error)) degradeReconcile(error, correlationId);
      }
    }
  }
  return sandbox;
}
