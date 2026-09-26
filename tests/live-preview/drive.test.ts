import { Drive, type Sandbox } from "@vercel/sandbox";
import { describe, expect, it } from "vitest";
import { readSandboxConfig } from "../../src/server/config";
import {
  ensureSandbox,
  HOBBY_SANDBOX_TIMEOUT_MS,
} from "../../src/server/sandbox/controller";
import type { SandboxHandle } from "../../src/server/sandbox/sdk-adapter";

const MARKER_PATH = "/workspace/telegram-agent/data/live-preview-marker.txt";
const WRITE_SCRIPT = `
const fs = require("fs");
const path = "/workspace/telegram-agent/data";
fs.mkdirSync(path, { recursive: true });
const tmp = path + "/.live-preview-marker.tmp";
const dest = path + "/live-preview-marker.txt";
const fd = fs.openSync(tmp, "w");
fs.writeSync(fd, process.env.MARKER);
fs.fsyncSync(fd);
fs.closeSync(fd);
fs.renameSync(tmp, dest);
`;

function assertGate(): void {
  if (process.env.TELEGRAM_AGENT_LIVE_PREVIEW !== "authorized")
    throw new Error("LIVE_PREVIEW_NOT_AUTHORIZED");
  if (process.env.TELEGRAM_AGENT_LOCAL_ROOT)
    throw new Error("LIVE_PREVIEW_LOCAL_ROOT_SET");
  if (!process.env.VERCEL_OIDC_TOKEN)
    throw new Error("LIVE_PREVIEW_CREDENTIAL_MISSING");
  for (const name of ["SANDBOX_DRIVE_NAME", "SANDBOX_NAME"] as const) {
    if (!/^telegram-agent-preview-[a-z0-9-]+$/.test(process.env[name] ?? ""))
      throw new Error("LIVE_PREVIEW_RESOURCE_MISMATCH");
  }
}

async function readText(sandbox: SandboxHandle, path: string): Promise<string> {
  const stream = await sandbox.readFile({ path });
  if (!stream) throw new Error("SANDBOX_FILE_MISSING");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

describe("authorized sin1 preview", () => {
  it("keeps one private writer and persisted files across stop and resume", async () => {
    assertGate();
    const config = readSandboxConfig();
    const started = (await ensureSandbox(config)) as SandboxHandle & Sandbox;
    expect(started.region).toBe("sin1");
    expect(started.name).toBe(config.SANDBOX_NAME);
    expect(started.mounts).toHaveProperty("/workspace");
    expect(started.routes).toEqual([]);
    expect(started.timeout ?? 0).toBeLessThanOrEqual(HOBBY_SANDBOX_TIMEOUT_MS);

    const marker = `preview-${Date.now()}`;
    const written = await started.runCommand({
      cmd: "node",
      args: ["-e", WRITE_SCRIPT],
      env: { MARKER: marker },
      timeoutMs: 60_000,
    });
    expect(written.exitCode).toBe(0);
    expect(await readText(started, MARKER_PATH)).toBe(marker);

    const drive = await Drive.getOrCreate({
      name: config.SANDBOX_DRIVE_NAME,
      region: "sin1",
    });
    expect(drive.region).toBe("sin1");
    expect(drive.name).toBe(config.SANDBOX_DRIVE_NAME);
    expect(drive.currentSandboxName).toBe(config.SANDBOX_NAME);

    await started.stop();
    const resumed = (await ensureSandbox(config)) as SandboxHandle & Sandbox;
    expect(resumed.region).toBe("sin1");
    expect(resumed.routes).toEqual([]);
    expect(await resumed.readFileToBuffer({ path: MARKER_PATH })).toEqual(
      Buffer.from(marker),
    );
  }, 180_000);
});
