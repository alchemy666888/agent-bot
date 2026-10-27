import { describe, expect, it, vi } from "vitest";
import {
  invokeWorker,
  workerBundlePath,
} from "../../../../src/server/sandbox/transport";
import type { SandboxHandle } from "../../../../src/server/sandbox/sdk-adapter";
import { uuidV7 } from "../../../../src/shared/ids";

function sandbox(response: unknown, exitCode = 0, stderr = ""): SandboxHandle {
  return {
    name: "agent",
    region: "sin1",
    mounts: { "/workspace": {} },
    status: "running",
    update: vi.fn(),
    stop: vi.fn(),
    writeFiles: vi.fn(async () => undefined),
    runCommand: vi.fn(async () => ({
      exitCode,
      stdout: async () => "",
      stderr: async () => stderr,
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
    expect(target.runCommand).toHaveBeenNthCalledWith(1, {
      cmd: "node",
      args: expect.any(Array),
      env: {
        REQUIRED_ONLY: "fixture",
        WORKER_PROGRESS_FILE: expect.stringMatching(
          /^\/tmp\/telegram-agent\/progress\/[A-Za-z0-9-]+\.json$/,
        ),
      },
      timeoutMs: 250_000,
    });
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
  it("returns the worker response when cleanup has no session", async () => {
    const correlationId = uuidV7();
    const target = sandbox({
      contractVersion: 1,
      correlationId,
      ok: true,
      data: {},
    });
    vi.mocked(target.runCommand)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: async () => "",
        stderr: async () => "",
      })
      .mockRejectedValueOnce(
        new Error("No active session. Run a command or call resume first."),
      );
    await expect(
      invokeWorker(target, "/tmp/worker.mjs", {
        contractVersion: 1,
        correlationId,
        operation: "health",
        payload: {},
      }),
    ).resolves.toMatchObject({ ok: true });
  });
  it("keeps the worker failure when cleanup has no session", async () => {
    const target = sandbox({}, 1);
    vi.mocked(target.runCommand)
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: async () => "",
        stderr: async () => "",
      })
      .mockRejectedValueOnce(
        new Error("No active session. Run a command or call resume first."),
      );
    await expect(
      invokeWorker(target, "/tmp/worker.mjs", {
        contractVersion: 1,
        correlationId: uuidV7(),
        operation: "health",
        payload: {},
      }),
    ).rejects.toThrow("WORKER_COMMAND_FAILED");
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
  it.each([
    [
      'Error: Dynamic require of "events" is not supported',
      "WORKER_BUNDLE_INCOMPATIBLE",
    ],
    [
      "Error: connect ECONNREFUSED 10.0.0.1:5432",
      "DATABASE_CONNECTION_REFUSED",
    ],
    [
      "Error: connect ENETUNREACH 2001:db8::1:5432",
      "DATABASE_NETWORK_UNREACHABLE",
    ],
    [
      'error: password authentication failed for user "telegram"',
      "DATABASE_AUTHENTICATION_FAILED",
    ],
    ["contains supersecretvalue", "WORKER_COMMAND_FAILED"],
    ["WORKER_COMMAND_TIMEOUT", "WORKER_COMMAND_TIMEOUT"],
    ["Error: Command timed out after 250000ms", "WORKER_COMMAND_TIMEOUT"],
  ])(
    "maps safe command diagnostics without exposing stderr",
    async (stderr, code) => {
      const target = sandbox({}, 1, stderr);
      await expect(
        invokeWorker(target, "/tmp/worker.mjs", {
          contractVersion: 1,
          correlationId: uuidV7(),
          operation: "health",
          payload: {},
        }),
      ).rejects.toThrow(code);
    },
  );
  it("attaches the last worker progress and drops unrecognized fields", async () => {
    const correlationId = uuidV7();
    const target = sandbox({}, 1, "WORKER_COMMAND_TIMEOUT");
    vi.mocked(target.readFileToBuffer).mockImplementation(async (file) => {
      if (!file.path.includes("/progress/")) return null;
      return Buffer.from(
        JSON.stringify({
          stage: "model",
          elapsedMs: 248_000,
          iteration: 2,
          executionMode: "forced_web_search",
          tool: "web_search",
          secret: "sk-should-not-pass",
          prompt: "CPI",
        }),
      );
    });
    await expect(
      invokeWorker(target, "/tmp/worker.mjs", {
        contractVersion: 1,
        correlationId,
        operation: "telegramTurn",
        payload: {},
      }),
    ).rejects.toMatchObject({
      message: "WORKER_COMMAND_TIMEOUT",
      operation: "telegramTurn",
      timeoutLimitMs: 250_000,
      progress: {
        stage: "model",
        elapsedMs: 248_000,
        iteration: 2,
        executionMode: "forced_web_search",
        tool: "web_search",
      },
    });
  });
});

describe("Vercel worker error forwarding", () => {
  it("forwards validated worker errors on successful commands and discards raw stderr", async () => {
    const correlationId = uuidV7();
    const target = sandbox({ contractVersion: 1, correlationId, ok: true, data: {} }, 0, [
      "raw stderr contains private-fixture",
      JSON.stringify({ component: "worker", result: "failure", metadata: { error: {
        code: "PROVIDER_REQUEST_TIMEOUT", classification: "transient", message: "Temporary operation failure",
        detail: "socket timeout", trace: ["at connect (socket.ts:7:3)"],
      } } }),
      JSON.stringify({ component: "worker", result: "failure", metadata: { error: { rawBody: "private-fixture" } } }),
    ].join("\n"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(invokeWorker(target, "/tmp/worker.mjs", {
        contractVersion: 1, correlationId, operation: "health", payload: {},
      })).resolves.toMatchObject({ ok: true });
      expect(error).toHaveBeenCalledTimes(1);
      const line = error.mock.calls[0]![0] as string;
      expect(JSON.parse(line)).toMatchObject({
        correlationId, level: "error", stage: "worker-diagnostic",
        metadata: { error: { detail: "socket timeout" } },
      });
      expect(line).not.toContain("private-fixture");
    } finally {
      error.mockRestore();
    }
  });
});
