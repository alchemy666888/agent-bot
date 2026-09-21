import { describe, expect, it, vi } from "vitest";
import {
  invokeWorker,
  workerBundlePath,
} from "../../../../src/server/sandbox/transport";
import type { SandboxHandle } from "../../../../src/server/sandbox/sdk-adapter";
import { uuidV7 } from "../../../../src/shared/ids";

function sandbox(response: unknown, exitCode = 0): SandboxHandle {
  return {
    name: "agent",
    region: "sin1",
    mounts: { "/workspace": {} },
    status: "running",
    writeFiles: vi.fn(async () => undefined),
    runCommand: vi.fn(async () => ({
      exitCode,
      stdout: async () => "",
      stderr: async () => "",
    })),
    readFileToBuffer: vi.fn(async () => Buffer.from(JSON.stringify(response))),
    readFile: vi.fn(async () => null),
  };
}

describe("private worker transport", () => {
  it("uses hashed non-Drive bundle paths", () => {
    expect(workerBundlePath(Buffer.from("worker"))).toMatch(
      /^\/tmp\/telegram-agent\/worker-[a-f0-9]{64}\.mjs$/,
    );
  });
  it("passes only supplied operation secrets and always cleans files", async () => {
    const correlationId = uuidV7();
    const target = sandbox({
      contractVersion: 1,
      correlationId,
      ok: true,
      data: {},
    });
    await invokeWorker(
      target,
      "/tmp/worker.mjs",
      { contractVersion: 1, correlationId, operation: "health", payload: {} },
      { REQUIRED_ONLY: "fixture" },
    );
    expect(target.runCommand).toHaveBeenNthCalledWith(
      1,
      "node",
      expect.any(Array),
      expect.objectContaining({ env: { REQUIRED_ONLY: "fixture" } }),
    );
    expect(target.runCommand).toHaveBeenLastCalledWith(
      "rm",
      expect.arrayContaining(["-f"]),
    );
  });
  it("rejects malformed responses and cleans files", async () => {
    const target = sandbox({ rawProviderBody: "unsafe" });
    await expect(
      invokeWorker(target, "/tmp/worker.mjs", {
        contractVersion: 1,
        correlationId: uuidV7(),
        operation: "health",
        payload: {},
      }),
    ).rejects.toThrow();
    expect(target.runCommand).toHaveBeenLastCalledWith(
      "rm",
      expect.arrayContaining(["-f"]),
    );
  });
  it("propagates command failure only after cleanup", async () => {
    const target = sandbox({}, 1);
    await expect(
      invokeWorker(target, "/tmp/worker.mjs", {
        contractVersion: 1,
        correlationId: uuidV7(),
        operation: "health",
        payload: {},
      }),
    ).rejects.toThrow("WORKER_COMMAND_FAILED");
    expect(target.runCommand).toHaveBeenCalledTimes(2);
  });
});
