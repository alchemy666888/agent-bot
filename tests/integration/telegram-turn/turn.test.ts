import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramTurn } from "../../../src/worker/orchestration/telegram-turn";
import { LockCoordinator } from "../../../src/worker/locks/coordinator";
import { UpdateRepository } from "../../../src/worker/updates/repository";
import { ConversationService } from "../../../src/worker/conversations/service";
let root = "";
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
describe("Telegram turn", () => {
  it("deduplicates complete updates and uses final content", async () => {
    root = await mkdtemp(join(tmpdir(), "turn-"));
    const model = { generate: vi.fn(async () => ({ content: "final" })) };
    const telegram = {
      typing: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
    };
    const turn = new TelegramTurn(
      new LockCoordinator(root),
      new UpdateRepository(root),
      new ConversationService(),
      model,
      telegram,
      "system",
    );
    const input = {
      kind: "text" as const,
      updateId: "1",
      messageId: "2",
      chatId: "3",
      userId: "4",
      text: "hello",
    };
    await turn.handle(input);
    await turn.handle(input);
    expect(model.generate).toHaveBeenCalledTimes(1);
    expect(telegram.send).toHaveBeenCalledTimes(1);
    expect(telegram.typing).toHaveBeenCalledTimes(1);
  });
  it("never calls model for commands", async () => {
    root = await mkdtemp(join(tmpdir(), "turn-"));
    const model = { generate: vi.fn() };
    const telegram = {
      typing: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
    };
    await new TelegramTurn(
      new LockCoordinator(root),
      new UpdateRepository(root),
      new ConversationService(),
      model,
      telegram,
      "system",
    ).handle({
      kind: "text",
      updateId: "2",
      messageId: "2",
      chatId: "3",
      userId: "4",
      text: "/help",
    });
    expect(model.generate).not.toHaveBeenCalled();
  });

  it("resumes prompt-saved and model-complete checkpoints", async () => {
    root = await mkdtemp(join(tmpdir(), "turn-"));
    const updates = new UpdateRepository(root);
    const conversations = new ConversationService();
    conversations.contact({ id: "4", at: new Date().toISOString() });
    conversations.add("4", "user", "hello");
    await updates.save({
      updateId: "3",
      stage: "prompt_saved",
      updatedAt: new Date().toISOString(),
    });
    const model = { generate: vi.fn(async () => ({ content: "resumed" })) };
    const telegram = {
      typing: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
    };
    const turn = new TelegramTurn(
      new LockCoordinator(root),
      updates,
      conversations,
      model,
      telegram,
      "system",
    );
    const input = {
      kind: "text" as const,
      updateId: "3",
      messageId: "2",
      chatId: "3",
      userId: "4",
      text: "hello",
    };
    await turn.handle(input);
    expect(model.generate).toHaveBeenCalledTimes(1);
    expect(model.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([{ role: "user", content: "hello" }]),
      }),
    );

    const state = await updates.get("3");
    expect(state?.stage).toBe("delivery_complete");
    await turn.handle(input);
    expect(model.generate).toHaveBeenCalledTimes(1);
    expect(telegram.send).toHaveBeenCalledTimes(1);
  });

  it("reuses a durably completed assistant response for delivery", async () => {
    root = await mkdtemp(join(tmpdir(), "turn-"));
    const updates = new UpdateRepository(root);
    const conversations = new ConversationService();
    conversations.contact({ id: "4", at: new Date().toISOString() });
    conversations.add("4", "user", "hello");
    const assistant = conversations.add("4", "assistant", "stored final");
    await updates.save({
      updateId: "6",
      stage: "model_complete",
      assistantId: assistant.id,
      updatedAt: new Date().toISOString(),
    });
    const model = { generate: vi.fn() };
    const telegram = {
      typing: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
    };
    await new TelegramTurn(
      new LockCoordinator(root),
      updates,
      conversations,
      model,
      telegram,
      "system",
    ).handle({
      kind: "text",
      updateId: "6",
      messageId: "2",
      chatId: "3",
      userId: "4",
      text: "hello",
    });
    expect(model.generate).not.toHaveBeenCalled();
    expect(telegram.send).toHaveBeenCalledWith("3", "stored final");
    expect(await updates.get("6")).toMatchObject({
      stage: "delivery_complete",
    });
  });

  it("retries transient model and delivery failures without regenerating", async () => {
    root = await mkdtemp(join(tmpdir(), "turn-"));
    const transient = Object.assign(new Error("temporary"), { status: 503 });
    const model = {
      generate: vi
        .fn()
        .mockRejectedValueOnce(transient)
        .mockResolvedValue({ content: "final" }),
    };
    const telegram = {
      typing: vi.fn(async () => {}),
      send: vi
        .fn()
        .mockRejectedValueOnce(new Error("TELEGRAM_DELIVERY_FAILED"))
        .mockResolvedValue(undefined),
    };
    await new TelegramTurn(
      new LockCoordinator(root),
      new UpdateRepository(root),
      new ConversationService(),
      model,
      telegram,
      "system",
    ).handle({
      kind: "text",
      updateId: "4",
      messageId: "2",
      chatId: "3",
      userId: "4",
      text: "hello",
    });
    expect(model.generate).toHaveBeenCalledTimes(2);
    expect(telegram.send).toHaveBeenCalledTimes(2);
  });

  it("sends a generic response and terminally checkpoints exhausted model failures", async () => {
    root = await mkdtemp(join(tmpdir(), "turn-"));
    const model = {
      generate: vi.fn(async () => {
        throw Object.assign(new Error("provider body must stay private"), {
          status: 503,
        });
      }),
    };
    const telegram = {
      typing: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
    };
    const updates = new UpdateRepository(root);
    await new TelegramTurn(
      new LockCoordinator(root),
      updates,
      new ConversationService(),
      model,
      telegram,
      "system",
    ).handle({
      kind: "text",
      updateId: "5",
      messageId: "2",
      chatId: "3",
      userId: "4",
      text: "hello",
    });
    expect(model.generate).toHaveBeenCalledTimes(3);
    expect(telegram.send).toHaveBeenCalledWith(
      "3",
      expect.stringContaining("try again later"),
    );
    expect(await updates.get("5")).toMatchObject({ stage: "failed" });
    expect(JSON.stringify(await updates.get("5"))).not.toContain(
      "provider body",
    );
  });
});
