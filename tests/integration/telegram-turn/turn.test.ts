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
});
