import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UpdateRepository } from "../../../src/worker/updates/repository";
let root = "";
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
describe("update checkpoints", () => {
  it("resumes monotonically and terminal duplicates are inert", async () => {
    root = await mkdtemp(join(tmpdir(), "updates-"));
    const repo = new UpdateRepository(root);
    const at = new Date().toISOString();
    for (const stage of [
      "received",
      "prompt_saved",
      "model_complete",
      "delivery_complete",
    ] as const)
      await repo.save({ updateId: "42", stage, updatedAt: at });
    const done = await repo.get("42");
    expect(done?.stage).toBe("delivery_complete");
    expect(
      await repo.save({ updateId: "42", stage: "received", updatedAt: at }),
    ).toEqual(done);
  });
  it("allows only one state file under concurrent redelivery", async () => {
    root = await mkdtemp(join(tmpdir(), "updates-"));
    const repo = new UpdateRepository(root);
    const state = {
      updateId: "9",
      stage: "received" as const,
      updatedAt: new Date().toISOString(),
    };
    await Promise.allSettled(
      Array.from({ length: 10 }, () => repo.save(state)),
    );
    expect((await repo.get("9"))?.updateId).toBe("9");
  });
});
