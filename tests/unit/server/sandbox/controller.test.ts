import { describe, expect, it, vi } from "vitest";
import { ensureSandbox } from "../../../../src/server/sandbox/controller";
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
  it("uses one private sin1 sandbox with persistence and resume", async () => {
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
      resume: true,
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
});
