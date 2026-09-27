import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Sandbox } from "@vercel/sandbox";
import { describe, expect, it } from "vitest";
import {
  GOOGLE_DRIVE_FOLDER_ID,
  googleDriveProcessEnv,
  readGoogleDriveConfig,
} from "../../src/shared/google-drive/config";
import { createGoogleDriveClient } from "../../src/shared/google-drive/client";
import { readSandboxConfig } from "../../src/server/config";
import {
  ensureSandbox,
  HOBBY_SANDBOX_TIMEOUT_MS,
} from "../../src/server/sandbox/controller";
import {
  installWorker,
  invokeWorker,
} from "../../src/server/sandbox/transport";
import type { SandboxHandle } from "../../src/server/sandbox/sdk-adapter";
import { uuidV7 } from "../../src/shared/ids";

type LiveSandbox = SandboxHandle &
  Sandbox & {
    timeout?: number;
    routes?: unknown[];
    stop: () => Promise<void>;
  };

function assertGate(): void {
  if (process.env.TELEGRAM_AGENT_LIVE_PREVIEW !== "authorized")
    throw new Error("LIVE_PREVIEW_NOT_AUTHORIZED");
  if (process.env.TELEGRAM_AGENT_LOCAL_ROOT)
    throw new Error("LIVE_PREVIEW_LOCAL_ROOT_SET");
  if (!process.env.VERCEL_OIDC_TOKEN)
    throw new Error("LIVE_PREVIEW_CREDENTIAL_MISSING");
  if (
    !/^telegram-agent-preview-[a-z0-9-]+$/.test(process.env.SANDBOX_NAME ?? "")
  )
    throw new Error("LIVE_PREVIEW_RESOURCE_MISMATCH");
  if (process.env.GOOGLE_DRIVE_FOLDER_ID !== GOOGLE_DRIVE_FOLDER_ID)
    throw new Error("LIVE_PREVIEW_RESOURCE_MISMATCH");
  readGoogleDriveConfig();
}

describe("authorized sin1 preview", () => {
  it("hydrates a Drive marker after the sandbox stops and resumes", async () => {
    assertGate();
    const config = readSandboxConfig();
    const started = (await ensureSandbox(config)) as LiveSandbox;
    expect(started.region).toBe("sin1");
    expect(started.name).toBe(config.SANDBOX_NAME);
    expect(started.mounts).not.toHaveProperty("/workspace");
    expect(started.routes ?? []).toEqual([]);
    expect(started.timeout ?? 0).toBeLessThanOrEqual(HOBBY_SANDBOX_TIMEOUT_MS);

    const marker = `preview-${Date.now()}`;
    const drive = createGoogleDriveClient(readGoogleDriveConfig());
    await drive.upload("data/live-preview-marker.txt", Buffer.from(marker));

    await started.stop();
    const resumed = (await ensureSandbox(config)) as LiveSandbox;
    expect(resumed.region).toBe("sin1");
    expect(resumed.routes ?? []).toEqual([]);
    await resumed.runCommand({
      cmd: "rm",
      args: ["-rf", "/tmp/telegram-agent/data"],
    });
    const workerPath = await installWorker(
      resumed,
      await readFile(join(process.cwd(), "dist", "worker.mjs")),
    );
    const correlationId = uuidV7();
    const response = await invokeWorker(
      resumed,
      workerPath,
      {
        contractVersion: 1,
        correlationId,
        operation: "recover",
        payload: { relativePath: "data/live-preview-marker.txt" },
      },
      {
        ...googleDriveProcessEnv(),
        TELEGRAM_AGENT_ROOT: "/tmp/telegram-agent",
      },
    );
    expect(response.ok).toBe(true);
    expect(response.data).toMatchObject({ text: marker });
  }, 180_000);
});
