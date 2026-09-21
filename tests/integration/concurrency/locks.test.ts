import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LockCoordinator } from "../../../src/worker/locks/coordinator";

let root = "";
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
describe("lock coordinator", () => {
  it("orders same-user turns while allowing ten users", async () => {
    root = await mkdtemp(join(tmpdir(), "locks-"));
    const locks = new LockCoordinator(root);
    const active = new Set<string>();
    const seen: string[] = [];
    const jobs: Promise<void>[] = [];
    for (let user = 0; user < 10; user++)
      for (const item of [1, 2])
        jobs.push(
          locks.withUser(String(user), async () => {
            expect(active.has(String(user))).toBe(false);
            active.add(String(user));
            await locks.withMutation(async () => {
              seen.push(`${user}:${item}`);
            }, String(user));
            active.delete(String(user));
          }),
        );
    await Promise.all(jobs);
    expect(seen).toHaveLength(20);
  });
  it("rejects mutation lock inversion", async () => {
    root = await mkdtemp(join(tmpdir(), "locks-"));
    await expect(
      new LockCoordinator(root).withMutation(async () => undefined, "1"),
    ).rejects.toThrow("LOCK_ORDER_VIOLATION");
  });
});
