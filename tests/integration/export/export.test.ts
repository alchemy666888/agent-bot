import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { LockCoordinator } from "../../../src/worker/locks/coordinator";
import { exportData } from "../../../src/worker/export/service";

const exec = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "telegram-export-test-"));
  roots.push(root);
  await mkdir(join(root, "data/records/messages"), { recursive: true });
  await mkdir(join(root, "data/state"), { recursive: true });
  await mkdir(join(root, "runtime/locks"), { recursive: true });
  await writeFile(join(root, "data/manifest.json"), '{"schemaVersion":1}');
  await writeFile(
    join(root, "data/records/messages/2026-09.jsonl"),
    '{"message":"committed"}\n',
  );
  await writeFile(join(root, "runtime/secret.env"), "TOKEN=never-export");
  return root;
}

describe("consistent data export", () => {
  it("creates a valid ZIP containing exactly the data tree", async () => {
    const root = await fixture();
    const result = await exportData({
      root,
      runtimeRoot: join(root, "non-drive-exports"),
      now: new Date("2026-09-25T12:34:56.789Z"),
    });
    const { stdout: names } = await exec("unzip", ["-Z1", result.archivePath]);
    expect(names.trim().split("\n")).toEqual([
      "data/manifest.json",
      "data/records/messages/2026-09.jsonl",
    ]);
    const { stdout: records } = await exec("unzip", [
      "-p",
      result.archivePath,
      "data/records/messages/2026-09.jsonl",
    ]);
    expect(JSON.parse(records.trim())).toEqual({ message: "committed" });
    expect((await readFile(result.archivePath)).includes("never-export")).toBe(
      false,
    );
    expect(result.filename).toBe(
      "telegram-agent-data-2026-09-25T12-34-56-789Z.zip",
    );
    expect(result.size).toBeGreaterThan(0);
  });

  it("takes its snapshot at the global mutation boundary and releases queued writes", async () => {
    const root = await fixture();
    const locks = new LockCoordinator(root, 30_000, 2_000);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const firstWrite = locks.withMutation(async () => {
      await held;
      await writeFile(join(root, "data/state/before.json"), '{"before":true}');
    });
    const pendingExport = exportData({
      root,
      runtimeRoot: join(root, "non-drive-exports"),
      locks,
    });
    const laterWrite = locks.withMutation(async () => {
      await writeFile(join(root, "data/state/after.json"), '{"after":true}');
    });
    release();
    const result = await pendingExport;
    await Promise.all([firstWrite, laterWrite]);
    const { stdout: names } = await exec("unzip", ["-Z1", result.archivePath]);
    expect(names).toContain("data/state/before.json");
    // The queued write may win the lock race, but it must be wholly before or after the snapshot.
    if (names.includes("data/state/after.json")) {
      const { stdout } = await exec("unzip", [
        "-p",
        result.archivePath,
        "data/state/after.json",
      ]);
      expect(stdout).toBe('{"after":true}');
    }
    expect(await readFile(join(root, "data/state/after.json"), "utf8")).toBe(
      '{"after":true}',
    );
  });

  it("removes temporary output when snapshot creation fails", async () => {
    const root = await fixture();
    await writeFile(join(root, "data/broken-link-target"), "x");
    const { symlink } = await import("node:fs/promises");
    await symlink(
      join(root, "data/broken-link-target"),
      join(root, "data/link"),
    );
    const runtimeRoot = join(root, "non-drive-exports");
    await expect(exportData({ root, runtimeRoot })).rejects.toThrow();
    expect(
      await import("node:fs/promises").then(({ readdir }) =>
        readdir(runtimeRoot),
      ),
    ).toEqual([]);
  });
});
