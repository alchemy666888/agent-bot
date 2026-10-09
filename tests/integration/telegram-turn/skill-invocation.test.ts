import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CapabilityRegistry } from "../../../src/worker/capabilities/registry";
import { DurableConversationService } from "../../../src/worker/conversations/durable-service";
import { LockCoordinator } from "../../../src/worker/locks/coordinator";
import { TelegramTurn } from "../../../src/worker/orchestration/telegram-turn";
import { initializeLayout } from "../../../src/worker/persistence/layout";
import { SkillResolver } from "../../../src/worker/skills/resolver";
import { UpdateRepository } from "../../../src/worker/updates/repository";

let root = "";
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("Telegram skill invocation", () => {
  it("deduplicates delivery while using the repository-backed resolver abstraction", async () => {
    root = await mkdtemp(join(tmpdir(), "telegram-skill-"));
    await initializeLayout(root);
    const locks = new LockCoordinator(root);
    const resolver = new SkillResolver(new CapabilityRegistry([]), [
      {
        id: "reports",
        name: "Reports",
        description: "Reports",
        versionId: "018f47a2-4cab-7a31-8f5f-4b6f6f2d62d1",
        manifestRevision: 1,
        instructions: "Use cited data.",
        visibility: "private",
        ownerTelegramUserIds: ["3"],
        allowedTelegramUserIds: [],
        triggers: { phrases: [], keywords: ["reports"], minimumConfidence: 1 },
        tools: [],
        prohibitedActions: [],
        status: "active",
      },
    ]);
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
      resolver,
    );
    const input = {
      kind: "text" as const,
      updateId: "100",
      messageId: "1",
      chatId: "2",
      userId: "3",
      text: "/skill reports prepare reports",
    };
    await turn.handle(input);
    await turn.handle(input);
    expect(telegram.send).toHaveBeenCalledTimes(1);
    expect(telegram.send).toHaveBeenCalledWith("2", expect.any(String));
  });
});
