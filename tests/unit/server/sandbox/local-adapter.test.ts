import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { selectSandboxSdk } from "../../../../src/server/sandbox/controller";
import { createLocalSandboxSdk } from "../../../../src/server/sandbox/local-adapter";
import { vercelSandboxSdk } from "../../../../src/server/sandbox/sdk-adapter";

let root = "";
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("local sandbox adapter", () => {
  it("keeps the Drive authoritative on Vercel and local otherwise", () => {
    expect(
      selectSandboxSdk({
        TELEGRAM_AGENT_LOCAL_ROOT: "/tmp/store",
        VERCEL: "1",
      }),
    ).toBe(vercelSandboxSdk);
    expect(
      selectSandboxSdk({ TELEGRAM_AGENT_LOCAL_ROOT: "/tmp/store" }),
    ).not.toBe(vercelSandboxSdk);
  });

  it("runs a private command without deleting the data root", async () => {
    root = await mkdtemp(join(tmpdir(), "local-sandbox-"));
    const marker = join(root, "data", "manifest.json");
    const sdk = createLocalSandboxSdk(root);
    const drive = await sdk.getOrCreateDrive({ name: "drive", region: "sin1" });
    const sandbox = await sdk.getOrCreateSandbox({
      name: "agent",
      region: "sin1",
      mounts: { "/workspace": drive },
      persistent: true,
      resume: true,
      timeout: 1,
      keepLastSnapshots: { count: 1 },
    });
    await sandbox.writeFiles([
      { path: marker, content: Buffer.from('{"schemaVersion":1}') },
    ]);
    const script = join(root, "probe.mjs");
    await sandbox.writeFiles([
      {
        path: script,
        content: Buffer.from("console.log(process.env.TELEGRAM_AGENT_ROOT)\n"),
      },
    ]);
    const result = await sandbox.runCommand("node", [script]);
    expect(result.exitCode).toBe(0);
    expect((await result.stdout()).trim()).toBe(root);
    const withSecret = await sandbox.runCommand({
      cmd: "node",
      args: ["-e", "console.log(process.env.MARKER)"],
      env: { MARKER: "kept" },
    });
    expect(withSecret.exitCode).toBe(0);
    expect((await withSecret.stdout()).trim()).toBe("kept");
    expect(await readFile(marker, "utf8")).toContain("schemaVersion");
    expect(
      (await sandbox.runCommand("rm", ["-rf", "/workspace"])).exitCode,
    ).toBe(1);
  });
});
