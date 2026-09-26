import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableConversationService } from "../../../src/worker/conversations/durable-service";
import { exportData } from "../../../src/worker/export/service";
import { LockCoordinator } from "../../../src/worker/locks/coordinator";
import { TelegramTurn } from "../../../src/worker/orchestration/telegram-turn";
import { UpdateRepository } from "../../../src/worker/updates/repository";
import { removeStore, temporaryStore } from "../../helpers/filesystem/root";

let root = "";
afterEach(async () => {
  if (root) await removeStore(root);
});

const prohibited =
  /first_name|last_name|reasoning_content|authorization|cookie|DEEPSEEK_API_KEY|TELEGRAM_BOT_TOKEN/i;

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  );
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? files(path) : [path];
    }),
  );
  return nested.flat();
}

describe("local filesystem acceptance", () => {
  it("isolates ten users, preserves order, and exports during writes", async () => {
    root = await temporaryStore("acceptance-");
    const order: string[] = [];
    const jobs = Array.from({ length: 10 }, (_, index) => {
      const userId = String(index + 1);
      const locks = new LockCoordinator(root, 30_000, 30_000);
      const model = {
        generate: vi.fn(async () => {
          order.push(`${userId}:first`);
          return {
            content: `answer ${userId}`,
            usage: { inputTokens: 2, outputTokens: 3 },
          };
        }),
      };
      return new TelegramTurn(
        locks,
        new UpdateRepository(root),
        new DurableConversationService(root, locks),
        model,
        { typing: async () => {}, send: async () => {} },
        "system",
        undefined,
        {
          inputPricePerMillion: "1",
          outputPricePerMillion: "2",
          thinkingEnabled: true,
        },
      ).handle({
        kind: "text",
        updateId: String(100 + index),
        messageId: String(200 + index),
        chatId: userId,
        userId,
        text: `hello ${userId}`,
      });
    });
    const [exported] = await Promise.all([
      exportData({
        root,
        now: new Date("2026-09-26T00:00:00.000Z"),
        locks: new LockCoordinator(root, 30_000, 30_000),
      }),
      ...jobs,
    ]);
    expect(exported.filename).toMatch(/^telegram-agent-data-/);
    const secondLocks = new LockCoordinator(root);
    const second = {
      generate: vi.fn(async () => {
        order.push("1:second");
        return { content: "second answer" };
      }),
    };
    await new TelegramTurn(
      secondLocks,
      new UpdateRepository(root),
      new DurableConversationService(root, secondLocks),
      second,
      { typing: async () => {}, send: async () => {} },
      "system",
    ).handle({
      kind: "text",
      updateId: "301",
      messageId: "302",
      chatId: "1",
      userId: "1",
      text: "second",
    });
    const duplicateModel = {
      generate: vi.fn(async () => ({ content: "nope" })),
    };
    const duplicateLocks = new LockCoordinator(root, 30_000, 30_000);
    await new TelegramTurn(
      duplicateLocks,
      new UpdateRepository(root),
      new DurableConversationService(root, duplicateLocks),
      duplicateModel,
      { typing: async () => {}, send: async () => {} },
      "system",
    ).handle({
      kind: "text",
      updateId: "100",
      messageId: "200",
      chatId: "1",
      userId: "1",
      text: "hello 1",
    });
    expect(duplicateModel.generate).not.toHaveBeenCalled();
    expect(order.filter((item) => item.startsWith("1:"))).toEqual([
      "1:first",
      "1:second",
    ]);
    const persisted = await files(join(root, "data"));
    expect(persisted.length).toBeGreaterThan(0);
    for (const path of persisted) {
      const text = await readFile(path, "utf8");
      expect(text).not.toMatch(prohibited);
      if (path.endsWith(".jsonl"))
        for (const line of text.split("\n").filter(Boolean))
          expect(JSON.parse(line)).toMatchObject({ schemaVersion: 1 });
      if (path.endsWith(".json")) expect(JSON.parse(text)).toBeTruthy();
    }
    const runs = await readdir(join(root, "data/state/model-runs"));
    expect(runs.length).toBe(10);
  });
});
