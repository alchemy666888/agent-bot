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
  const drive = await sdk.getOrCreateDrive({
    name: config.SANDBOX_DRIVE_NAME,
    region: "sin1",
  });
  if (drive.name !== config.SANDBOX_DRIVE_NAME || drive.region !== "sin1")
    throw new Error("SANDBOX_CONFIGURATION_MISMATCH");
  if (
    drive.currentSandboxName &&
    drive.currentSandboxName !== config.SANDBOX_NAME
  )
    throw new Error("DRIVE_ALREADY_ATTACHED");
  const sandbox = await sdk.getOrCreateSandbox({
    name: config.SANDBOX_NAME,
    region: "sin1",
    mounts: { "/workspace": drive },
    persistent: true,
    resume: true,
    timeout: HOBBY_SANDBOX_TIMEOUT_MS,
    keepLastSnapshots: { count: 1 },
  });
  if (
    sandbox.name !== config.SANDBOX_NAME ||
    sandbox.region !== "sin1" ||
    !("/workspace" in sandbox.mounts)
  )
    throw new Error("SANDBOX_CONFIGURATION_MISMATCH");
  return sandbox;
}
