import { describe, expect, it, vi } from "vitest";
import {
  ensureSandbox,
  resetSandbox,
} from "../../../../src/server/sandbox/controller";
import type {
  SandboxHandle,
  SandboxSdk,
} from "../../../../src/server/sandbox/sdk-adapter";

const handle = (): SandboxHandle => ({
  name: "agent",
  region: "sin1",
  mounts: {},
  status: "running",
  update: vi.fn(),
  stop: vi.fn(),
  writeFiles: vi.fn(),
  runCommand: vi.fn(),
  readFileToBuffer: vi.fn(),
  readFile: vi.fn(),
});
const config = {
  SANDBOX_NAME: "agent",
  region: "sin1" as const,
};

describe("sandbox lifecycle", () => {
  it("uses one private sin1 sandbox without resuming during lookup", async () => {
    const sdk: SandboxSdk = {
      getOrCreateSandbox: vi.fn(async () => handle()),
    };
    await expect(ensureSandbox(config, sdk)).resolves.toMatchObject({
      name: "agent",
    });
    const input = vi.mocked(sdk.getOrCreateSandbox).mock.calls[0]?.[0];
    expect(input).toMatchObject({
      region: "sin1",
      persistent: true,
      resume: false,
    });
    expect(input).not.toHaveProperty("mounts");
    expect(input).not.toHaveProperty("ports");
  });

  it("fails closed when the provider returns a different name", async () => {
    const sdk: SandboxSdk = {
      getOrCreateSandbox: vi.fn(async () => ({
        ...handle(),
        name: "other",
      })),
    };
    await expect(ensureSandbox(config, sdk)).rejects.toThrow(
      "SANDBOX_CONFIGURATION_MISMATCH",
    );
  });

  it("reconciles an existing sandbox created with stale configuration", async () => {
    const stale = {
      ...handle(),
      region: "iad1",
      routes: ["/public"],
    };
    const sdk: SandboxSdk = {
      getOrCreateSandbox: vi.fn(async () => stale),
    };

    await expect(ensureSandbox(config, sdk)).resolves.toBe(stale);
    expect(stale.update).toHaveBeenCalledWith({
      persistent: true,
      region: "sin1",
      failoverRegions: [],
      ports: [],
      timeout: 45 * 60 * 1000,
      keepLastSnapshots: { count: 1 },
    });
    expect(stale.stop).toHaveBeenCalledOnce();
  });

  it("removes public routes without restarting a correctly placed sandbox", async () => {
    const exposed = { ...handle(), routes: ["/public"] };
    const sdk: SandboxSdk = {
      getOrCreateSandbox: vi.fn(async () => exposed),
    };

    await ensureSandbox(config, sdk);
    expect(exposed.update).toHaveBeenCalledWith(
      expect.objectContaining({ ports: [] }),
    );
    expect(exposed.stop).not.toHaveBeenCalled();
  });

  it("continues when the routes getter has no active session", async () => {
    const idle = handle();
    Object.defineProperty(idle, "routes", {
      get() {
        throw new Error(
          "No active session. Run a command or call resume first.",
        );
      },
    });
    const sdk: SandboxSdk = {
      getOrCreateSandbox: vi.fn(async () => idle),
    };

    await expect(ensureSandbox(config, sdk)).resolves.toBe(idle);
    expect(idle.update).not.toHaveBeenCalled();
    expect(idle.stop).not.toHaveBeenCalled();
  });

  it("reconciles region without stopping a sessionless sandbox", async () => {
    const idle = {
      ...handle(),
      region: "iad1",
    };
    const noSession = new Error(
      "No active session. Run a command or call resume first.",
    );
    Object.defineProperty(idle, "routes", {
      get() {
        throw noSession;
      },
    });
    Object.defineProperty(idle, "status", {
      get() {
        throw noSession;
      },
    });
    const sdk: SandboxSdk = {
      getOrCreateSandbox: vi.fn(async () => idle),
    };

    await expect(ensureSandbox(config, sdk)).resolves.toBe(idle);
    expect(idle.update).toHaveBeenCalledWith({
      persistent: true,
      region: "sin1",
      failoverRegions: [],
      ports: [],
      timeout: 45 * 60 * 1000,
      keepLastSnapshots: { count: 1 },
    });
    expect(idle.stop).not.toHaveBeenCalled();
  });

  it("keeps the sandbox when region reconciliation is rejected", async () => {
    const stale = {
      ...handle(),
      region: "iad1",
      update: vi.fn(async () => {
        throw Object.assign(new Error("Status code 400 is not ok"), {
          response: { status: 400 },
          json: { error: { code: "invalid_region" } },
        });
      }),
    };
    const sdk: SandboxSdk = {
      getOrCreateSandbox: vi.fn(async () => stale),
    };
    const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await expect(ensureSandbox(config, sdk, "correlation-id")).resolves.toBe(
        stale,
      );
      expect(stale.stop).not.toHaveBeenCalled();
      const event = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
      expect(event).toMatchObject({
        correlationId: "correlation-id",
        operation: "sandbox.reconcile",
        result: "degraded",
        code: "SANDBOX_UNAVAILABLE",
        metadata: { status: 400, causeCode: "invalid_region" },
      });
    } finally {
      log.mockRestore();
    }
  });

  it("records the sandbox API status and provider code", async () => {
    const sdk: SandboxSdk = {
      getOrCreateSandbox: vi.fn(async () => {
        throw Object.assign(new Error("Status code 400 is not ok"), {
          response: { status: 400 },
          json: { error: { code: "snapshot_not_found" } },
        });
      }),
    };

    await expect(ensureSandbox(config, sdk)).rejects.toMatchObject({
      message: "SANDBOX_UNAVAILABLE",
      code: "snapshot_not_found",
      status: 400,
    });
  });

  it("deletes a stale named sandbox before creating its replacement", async () => {
    const sdk: SandboxSdk = {
      getOrCreateSandbox: vi.fn(async () => handle()),
      deleteSandbox: vi.fn(async () => undefined),
    };
    await expect(
      resetSandbox(config, sdk, "correlation-id"),
    ).resolves.toMatchObject({ name: "agent" });
    expect(sdk.deleteSandbox).toHaveBeenCalledWith("agent");
    expect(sdk.getOrCreateSandbox).toHaveBeenCalledOnce();
  });
});
