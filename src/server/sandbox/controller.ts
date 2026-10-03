import "server-only";

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

export async function ensureSandbox(
  config: SandboxConfig,
  sdk: SandboxSdk = selectSandboxSdk(),
): Promise<SandboxHandle> {
  const sandbox = await sdk.getOrCreateSandbox({
    name: config.SANDBOX_NAME,
    region: "sin1",
    persistent: true,
    resume: true,
    timeout: HOBBY_SANDBOX_TIMEOUT_MS,
    keepLastSnapshots: { count: 1 },
  });
  const routes = (sandbox as { routes?: unknown }).routes;
  if (sandbox.name !== config.SANDBOX_NAME)
    throw new Error("SANDBOX_CONFIGURATION_MISMATCH");

  // getOrCreate applies creation options only to a new named sandbox. Reconcile
  // an existing sandbox as well, otherwise a sandbox first created in the SDK's
  // default region (iad1) is returned forever and every request fails below.
  const regionMismatch = sandbox.region !== config.region;
  const hasPublicRoutes = Array.isArray(routes) && routes.length > 0;
  if (regionMismatch || hasPublicRoutes) {
    await sandbox.update({
      persistent: true,
      region: config.region,
      failoverRegions: [],
      ports: [],
      timeout: HOBBY_SANDBOX_TIMEOUT_MS,
      keepLastSnapshots: { count: 1 },
    });
    // Region changes apply to the next session. Stop the old session so the
    // first worker command resumes it in sin1 rather than continuing in iad1.
    if (regionMismatch && sandbox.status !== "stopped") await sandbox.stop();
  }
  return sandbox;
}
