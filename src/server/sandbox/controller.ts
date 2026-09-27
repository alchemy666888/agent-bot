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
  if (
    sandbox.name !== config.SANDBOX_NAME ||
    sandbox.region !== "sin1" ||
    (Array.isArray(routes) && routes.length > 0)
  )
    throw new Error("SANDBOX_CONFIGURATION_MISMATCH");
  return sandbox;
}
