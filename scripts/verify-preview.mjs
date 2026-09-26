import { spawn } from "node:child_process";

const authorized = process.env.TELEGRAM_AGENT_LIVE_PREVIEW === "authorized";
const drive = process.env.SANDBOX_DRIVE_NAME ?? "";
const sandbox = process.env.SANDBOX_NAME ?? "";
const namedTestResource = /^telegram-agent-preview-[a-z0-9-]+$/;

if (!authorized) {
  console.error(
    "LIVE_PREVIEW_NOT_AUTHORIZED: set TELEGRAM_AGENT_LIVE_PREVIEW=authorized for the exact Preview project before running live Drive checks.",
  );
  process.exit(2);
}
if (!namedTestResource.test(drive) || !namedTestResource.test(sandbox)) {
  console.error(
    "LIVE_PREVIEW_RESOURCE_MISMATCH: SANDBOX_DRIVE_NAME and SANDBOX_NAME must be exact telegram-agent-preview-* test resources.",
  );
  process.exit(2);
}
if (!process.env.VERCEL_OIDC_TOKEN) {
  console.error(
    "LIVE_PREVIEW_CREDENTIAL_MISSING: a pulled VERCEL_OIDC_TOKEN is required. Production OIDC is not available in this local run.",
  );
  process.exit(2);
}

const child = spawn("pnpm", ["exec", "vitest", "run", "tests/live-preview"], {
  stdio: "inherit",
  env: process.env,
});
child.on("exit", (code) => process.exit(code ?? 1));
