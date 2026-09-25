import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableConversationService } from "../../../src/worker/conversations/durable-service";
import { LockCoordinator } from "../../../src/worker/locks/coordinator";
import { TelegramTurn } from "../../../src/worker/orchestration/telegram-turn";
import {
  initializeLayout,
  statePath,
} from "../../../src/worker/persistence/layout";
import { UpdateRepository } from "../../../src/worker/updates/repository";

let root = "";
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("durable Telegram turn", () => {
  it("resumes model-complete delivery in a fresh worker without regeneration", async () => {
    root = await mkdtemp(join(tmpdir(), "durable-turn-"));
    await initializeLayout(root);
    const input = {
      kind: "text" as const,
      updateId: "101",
      messageId: "201",
      chatId: "301",
      userId: "401",
      text: "hello",
    };
    const firstLocks = new LockCoordinator(root);
    const model = {
      generate: vi.fn(async () => ({ content: "durable final" })),
    };
    const failedDelivery = {
      typing: vi.fn(async () => {}),
      send: vi.fn(async () => {
        throw new Error("TELEGRAM_DELIVERY_FAILED");
      }),
    };
    await expect(
      new TelegramTurn(
        firstLocks,
        new UpdateRepository(root),
        new DurableConversationService(root, firstLocks),
        model,
        failedDelivery,
        "system",
      ).handle(input),
    ).rejects.toThrow("TELEGRAM_DELIVERY_FAILED");
    expect((await new UpdateRepository(root).get("101"))?.stage).toBe(
      "model_complete",
    );

    const secondLocks = new LockCoordinator(root);
    const resumedModel = { generate: vi.fn() };
    const delivered = {
      typing: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
    };
    await new TelegramTurn(
      secondLocks,
      new UpdateRepository(root),
      new DurableConversationService(root, secondLocks),
      resumedModel,
      delivered,
      "system",
    ).handle(input);

    expect(resumedModel.generate).not.toHaveBeenCalled();
    expect(delivered.send).toHaveBeenCalledWith("301", "durable final");
    expect((await new UpdateRepository(root).get("101"))?.stage).toBe(
      "delivery_complete",
    );
    const user = JSON.parse(
      await readFile(statePath(root, "users", "401"), "utf8"),
    ) as Record<string, unknown>;
    expect(user).toMatchObject({
      telegramUserId: "401",
      firstSeenAt: expect.any(String),
      lastSeenAt: expect.any(String),
    });
    expect(user).not.toHaveProperty("firstName");
  });
});
