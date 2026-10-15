import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerResponse } from "../../../../src/shared/contracts";
import type { SandboxHandle } from "../../../../src/server/sandbox/sdk-adapter";

vi.mock("../../../../src/server/sandbox/transport", () => ({
  installWorker: vi.fn(async () => "worker.mjs"),
  invokeWorker: vi.fn(),
}));

import { executeWorker } from "../../../../src/server/sandbox/execute";
import { invokeWorker } from "../../../../src/server/sandbox/transport";

const sandbox = { name: "remote" } as SandboxHandle;
const local = { name: "local" } as SandboxHandle;
const request = {
  contractVersion: 1 as const,
  correlationId: "018f47a2-4cab-7a31-8f5f-4b6f6f2d62d0",
  operation: "telegramTurn" as const,
  payload: {},
};
const answered: WorkerResponse = {
  contractVersion: 1,
  correlationId: request.correlationId,
  ok: true,
  data: { handled: "telegramTurn" },
};

describe("executeWorker", () => {
  beforeEach(() => {
    vi.mocked(invokeWorker).mockReset();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });

  it("returns the sandbox worker result", async () => {
    vi.mocked(invokeWorker).mockResolvedValueOnce(answered);
    const openLocal = vi.fn(async () => local);
    await expect(
      executeWorker({
        correlationId: "correlation-id",
        source: Buffer.from("worker"),
        request,
        env: {},
        openSandbox: async () => sandbox,
        openLocal,
      }),
    ).resolves.toBe(answered);
    expect(openLocal).not.toHaveBeenCalled();
  });

  it("runs locally when the sandbox cannot start", async () => {
    vi.mocked(invokeWorker).mockResolvedValueOnce(answered);
    const openLocal = vi.fn(async () => local);
    await expect(
      executeWorker({
        correlationId: "correlation-id",
        source: Buffer.from("worker"),
        request,
        env: { TELEGRAM_BOT_TOKEN: "token" },
        openSandbox: async () => {
          throw Object.assign(new Error("SANDBOX_UNAVAILABLE"), {
            status: 400,
            code: "snapshot_not_found",
          });
        },
        openLocal,
      }),
    ).resolves.toBe(answered);
    expect(openLocal).toHaveBeenCalledOnce();
    expect(invokeWorker).toHaveBeenCalledWith(local, "worker.mjs", request, {
      TELEGRAM_BOT_TOKEN: "token",
    });
  });

  it("runs locally when sandbox persistence cannot sync", async () => {
    vi.mocked(invokeWorker)
      .mockResolvedValueOnce({
        contractVersion: 1,
        correlationId: request.correlationId,
        ok: false,
        error: {
          code: "DATABASE_NETWORK_UNREACHABLE",
          classification: "permanent",
          message: "Operation failed",
          diagnostic: { stage: "persistence-sync", kind: "error" },
        },
      })
      .mockResolvedValueOnce(answered);
    const openLocal = vi.fn(async () => local);
    await expect(
      executeWorker({
        source: Buffer.from("worker"),
        request,
        env: {},
        openSandbox: async () => sandbox,
        openLocal,
      }),
    ).resolves.toBe(answered);
    expect(openLocal).toHaveBeenCalledOnce();
  });

  it("does not hide a request the sandbox rejected as invalid", async () => {
    const openLocal = vi.fn(async () => local);
    await expect(
      executeWorker({
        source: Buffer.from("worker"),
        request,
        env: {},
        openSandbox: async () => {
          throw new Error("WORKER_CONTEXT_TOO_LARGE");
        },
        openLocal,
      }),
    ).rejects.toThrow("WORKER_CONTEXT_TOO_LARGE");
    expect(openLocal).not.toHaveBeenCalled();
  });
});
