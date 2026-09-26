import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { uuidV7 } from "../../../src/shared/ids";
import { DurableErrorService } from "../../../src/worker/errors/service";
import { LockCoordinator } from "../../../src/worker/locks/coordinator";
import { initializeLayout } from "../../../src/worker/persistence/layout";

describe("durable sanitized failures", () => {
  it("commits a correlated error event and projection without raw errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "errors-"));
    await initializeLayout(root);
    const service = new DurableErrorService(root, new LockCoordinator(root));
    const correlationId = uuidV7();
    const id = await service.record({
      correlationId,
      stage: "provider",
      error: new Error("Bearer bot-supersecretvalue"),
      updateId: "42",
    });
    const projection = await readFile(
      join(root, "data/state/errors", `${id}.json`),
      "utf8",
    );
    expect(projection).toContain(correlationId);
    expect(projection).toContain('"stage":"provider"');
    expect(projection).not.toMatch(/Bearer|supersecretvalue|stack/);
    const records = await readFile(
      join(
        root,
        "data/records/errors",
        `${new Date().toISOString().slice(0, 7)}.jsonl`,
      ),
      "utf8",
    );
    expect(records.trim().split("\n")).toHaveLength(1);
    expect(records).not.toMatch(/Bearer|supersecretvalue|stack/);
  });
});
