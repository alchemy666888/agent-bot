import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { uuidV7 } from "../../../src/shared/ids";
import { EventStore } from "../../../src/worker/persistence/event-store";
import { recoverJsonl } from "../../../src/worker/persistence/recovery";

let root = "";
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
describe("append-only persistence", () => {
  it("appends independently parseable lines and quarantines a partial tail", async () => {
    root = await mkdtemp(join(tmpdir(), "agent-"));
    const store = new EventStore(root);
    const event = {
      schemaVersion: 1 as const,
      eventId: uuidV7(),
      entityId: "user-1",
      kind: "users" as const,
      type: "user.seen",
      occurredAt: "2026-09-20T00:00:00.000Z",
      revision: 1,
      payload: { telegramUserId: "1" },
    };
    const path = await store.append(event);
    await import("node:fs/promises").then(({ appendFile }) =>
      appendFile(path, '{"partial"'),
    );
    expect(
      await recoverJsonl(path, join(root, "data/recovery/quarantine")),
    ).toEqual([event]);
    expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(1);
  });
  it("rejects prohibited durable fields", async () => {
    root = await mkdtemp(join(tmpdir(), "agent-"));
    await expect(
      new EventStore(root).append({
        schemaVersion: 1,
        eventId: uuidV7(),
        entityId: "x",
        kind: "users",
        type: "bad",
        occurredAt: new Date().toISOString(),
        revision: 1,
        payload: { first_name: "private" },
      }),
    ).rejects.toThrow();
  });
});
