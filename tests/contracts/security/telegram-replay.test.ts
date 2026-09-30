import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UpdateRepository } from "../../../src/worker/updates/repository";

describe("Telegram replay security contract", () => {
  it("does not move a terminal update back into processing", async () => {
    const repository = new UpdateRepository(
      await mkdtemp(join(tmpdir(), "replay-")),
    );
    const complete = {
      updateId: "999",
      stage: "delivery_complete" as const,
      updatedAt: new Date().toISOString(),
    };
    await repository.save(complete);
    const replay = await repository.save({
      ...complete,
      stage: "received",
      updatedAt: new Date(Date.now() + 1_000).toISOString(),
    });
    expect(replay).toEqual(complete);
  });
});
