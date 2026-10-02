import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableConversationService } from "../../../src/worker/conversations/durable-service";
import { LockCoordinator } from "../../../src/worker/locks/coordinator";
import { TelegramTurn } from "../../../src/worker/orchestration/telegram-turn";
import { initializeLayout } from "../../../src/worker/persistence/layout";
import { SkillResolver } from "../../../src/worker/skills/resolver";
import { CapabilityRegistry } from "../../../src/worker/capabilities/registry";
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
        commitSha: "a".repeat(40),
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

describe("server dispatch skill authoring", () => {
  it("intercepts an authoring turn before prompt resolution and sandbox routing", async () => {
    const prior = { ...process.env };
    Object.assign(process.env, {
      TELEGRAM_BOT_TOKEN: "test-token",
      TELEGRAM_WEBHOOK_SECRET: "test-secret",
      DEEPSEEK_API_KEY: "model-key",
      DEEPSEEK_INPUT_PRICE_PER_MILLION: "0",
      DEEPSEEK_OUTPUT_PRICE_PER_MILLION: "0",
    });
    const { installDispatchSkillAuthoringService, dispatchTelegramInput } =
      await import("../../../src/server/telegram/dispatch");
    const handle = vi.fn(
      async () =>
        "Draft revision 2\nCommit: abc\nDigest: sha256:def\nApprove: /skill_approve 2",
    );
    installDispatchSkillAuthoringService({
      shouldHandle: vi.fn(async () => true),
      handle,
    });
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    try {
      await expect(
        dispatchTelegramInput(
          {
            kind: "text",
            updateId: "501",
            messageId: "11",
            chatId: "22",
            userId: "42",
            text: "Create a skill called reports",
          },
          "authoring-correlation",
        ),
      ).resolves.toMatchObject({ data: { handled: "skill-authoring" } });
      expect(handle).toHaveBeenCalledWith(
        "42",
        "Create a skill called reports",
        "501",
      );
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0]![0]).toContain("sendMessage");
    } finally {
      installDispatchSkillAuthoringService(undefined);
      fetch.mockRestore();
      process.env = prior;
    }
  });
});
