import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableConversationService } from "../../../src/worker/conversations/durable-service";
import { LockCoordinator } from "../../../src/worker/locks/coordinator";
import { TelegramTurn } from "../../../src/worker/orchestration/telegram-turn";
import { initializeLayout } from "../../../src/worker/persistence/layout";
import { DurableSkillDraftRepository } from "../../../src/worker/skills/repository";
import { SkillAuthoringService } from "../../../src/worker/skills/service";
import { UpdateRepository } from "../../../src/worker/updates/repository";

let root = "";
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("Telegram skill authoring", () => {
  it("deduplicates updates across durable clarification and draft delivery", async () => {
    root = await mkdtemp(join(tmpdir(), "telegram-skill-"));
    await initializeLayout(root);
    const locks = new LockCoordinator(root);
    const generator = {
      generateSkillDraft: vi.fn(
        async () =>
          "---\nname: reports\ndescription: Reports\n---\nDo the work.",
      ),
    };
    const skills = new SkillAuthoringService(
      root,
      new DurableSkillDraftRepository(root, locks),
      generator,
    );
    const telegram = {
      typing: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
    };
    const turn = new TelegramTurn(
      locks,
      new UpdateRepository(root),
      new DurableConversationService(root, locks),
      { generate: vi.fn() },
      telegram,
      "system",
      undefined,
      undefined,
      skills,
    );
    const input = {
      kind: "text" as const,
      updateId: "100",
      messageId: "1",
      chatId: "2",
      userId: "3",
      text: "Create a skill\nName: reports\nTasks: prepare reports\nMUST DO: cite data\nMUST NOT DO: invent data\nBETTER TO DO: use tables",
    };
    await turn.handle(input);
    await turn.handle(input);
    expect(generator.generateSkillDraft).toHaveBeenCalledTimes(1);
    expect(telegram.send).toHaveBeenCalledTimes(1);
    expect(telegram.send).toHaveBeenCalledWith(
      "2",
      expect.stringContaining("/skill_approve 1"),
    );
  });
});
