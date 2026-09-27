import { spawn, spawnSync } from "node:child_process";

const GOOGLE_DRIVE_FOLDER_ID = "1cMXhFmW-bV_JHRRv56ajhWADpM-i-3Wo";
const authorized = process.env.TELEGRAM_AGENT_LIVE_PREVIEW === "authorized";
const sandbox = process.env.SANDBOX_NAME ?? "";
const namedTestResource = /^telegram-agent-preview-[a-z0-9-]+$/;

if (!authorized) {
  console.error(
    "LIVE_PREVIEW_NOT_AUTHORIZED: set TELEGRAM_AGENT_LIVE_PREVIEW=authorized for the exact Preview project before running live Drive checks.",
  );
  process.exit(2);
}
if (
  !namedTestResource.test(sandbox) ||
  process.env.GOOGLE_DRIVE_FOLDER_ID !== GOOGLE_DRIVE_FOLDER_ID
) {
  console.error(
    "LIVE_PREVIEW_RESOURCE_MISMATCH: SANDBOX_NAME must be an exact telegram-agent-preview-* test resource and GOOGLE_DRIVE_FOLDER_ID must be the configured folder.",
  );
  process.exit(2);
}
if (!process.env.VERCEL_OIDC_TOKEN) {
  console.error(
    "LIVE_PREVIEW_CREDENTIAL_MISSING: a pulled VERCEL_OIDC_TOKEN is required. Production OIDC is not available in this local run.",
  );
  process.exit(2);
}
for (const name of [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REFRESH_TOKEN",
]) {
  if (!process.env[name]) {
    console.error(
      "LIVE_PREVIEW_CREDENTIAL_MISSING: Google OAuth client id, secret, and refresh token are required.",
    );
    process.exit(2);
  }
}

const build = spawnSync("pnpm", ["worker:build"], { stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);

const child = spawn(
  "pnpm",
  ["exec", "vitest", "run", "tests/live-preview/drive.test.ts"],
  {
    stdio: "inherit",
    env: { ...process.env, VITEST_LIVE: "1" },
  },
);
child.on("exit", (code) => process.exit(code ?? 1));
