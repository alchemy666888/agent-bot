import { describe, expect, it, vi } from "vitest";
import { ensureSandbox } from "../../../../src/server/sandbox/controller";
import type {
  SandboxHandle,
  SandboxSdk,
} from "../../../../src/server/sandbox/sdk-adapter";

const handle = (): SandboxHandle => ({
  name: "agent",
  region: "sin1",
  mounts: { "/workspace": {} },
  status: "running",
  writeFiles: vi.fn(),
  runCommand: vi.fn(),
  readFileToBuffer: vi.fn(),
  readFile: vi.fn(),
});
const config = {
  SANDBOX_DRIVE_NAME: "drive",
  SANDBOX_NAME: "agent",
  region: "sin1" as const,
};

describe("sandbox lifecycle", () => {
  it("uses one private sin1 mount with persistence and resume", async () => {
    const sdk: SandboxSdk = {
      getOrCreateDrive: vi.fn(async () => ({ name: "drive", region: "sin1" })),
      getOrCreateSandbox: vi.fn(async () => handle()),
    };
    await expect(ensureSandbox(config, sdk)).resolves.toMatchObject({
      name: "agent",
    });
    expect(sdk.getOrCreateSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        region: "sin1",
        persistent: true,
        resume: true,
        mounts: { "/workspace": expect.anything() },
      }),
    );
    expect(sdk.getOrCreateSandbox).not.toHaveBeenCalledWith(
      expect.objectContaining({ ports: expect.anything() }),
    );
  });
  it.each([
    { name: "drive", region: "iad1" },
    { name: "drive", region: "sin1", currentSandboxName: "other" },
  ])("fails closed for invalid drive %#", async (drive) => {
    const sdk = {
      getOrCreateDrive: vi.fn(async () => drive),
      getOrCreateSandbox: vi.fn(),
    } as unknown as SandboxSdk;
    await expect(ensureSandbox(config, sdk)).rejects.toThrow();
    expect(sdk.getOrCreateSandbox).not.toHaveBeenCalled();
  });
});
