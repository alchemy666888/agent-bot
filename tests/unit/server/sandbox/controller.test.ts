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

  it.each([
    { name: "agent", region: "iad1" },
    { name: "other", region: "sin1" },
    { name: "agent", region: "sin1", routes: ["/public"] },
  ])("fails closed for an unexpected sandbox %#", async (sandbox) => {
    const sdk: SandboxSdk = {
      getOrCreateSandbox: vi.fn(async () => ({
        ...handle(),
        ...sandbox,
      })),
    };
    await expect(ensureSandbox(config, sdk)).rejects.toThrow(
      "SANDBOX_CONFIGURATION_MISMATCH",
    );
  });
});
