import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { TelegramTurn } from "../../../src/worker/orchestration/telegram-turn";
import { LockCoordinator } from "../../../src/worker/locks/coordinator";
import { UpdateRepository } from "../../../src/worker/updates/repository";
import { ConversationService } from "../../../src/worker/conversations/service";
import { CapabilityRegistry } from "../../../src/worker/capabilities/registry";
import { SkillResolver } from "../../../src/worker/skills/resolver";
let root = "";
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
describe("Telegram turn", () => {
  it("keeps all degradation diagnostics out of stored and delivered answers", async () => {
    root = await mkdtemp(join(tmpdir(), "turn-"));
    const conversations = new ConversationService();
    const telegram = {
      typing: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
    };
    const turn = new TelegramTurn(
      new LockCoordinator(root),
      new UpdateRepository(root),
      conversations,
      {
        generate: vi.fn(async () => ({
          content: [
            "已解碼你的請求：「香港今天有什麼新聞」。",
            "Useful answer",
            "",
            "⚠️ 提醒：以上為搜尋引擎抓取的即時報導，具體時間與發展以各新聞機構最新更新為準。",
            "",
            "需要我針對其中某一則新聞深入整理嗎？😊",
          ].join("\n"),
        })),
      },
      telegram,
      "system",
      undefined,
      undefined,
      undefined,
      [],
      undefined,
      undefined,
      60_000,
      { mode: "enforced" },
      undefined,
      [
        "repository_unavailable",
        "catalog_missing",
        "catalog_too_large",
        "stale_snapshot",
        "system_prompt_missing",
        "request_prompt_missing",
        "compiled_emergency_prompt",
      ],
    );
    await turn.handle({
      kind: "text",
      updateId: "9001",
      messageId: "2",
      chatId: "3",
      userId: "4",
      text: "hello",
    });

    const delivered = telegram.send.mock.calls[0]?.[1];
    expect(delivered).toBe("Useful answer");
    expect(telegram.send).toHaveBeenCalledTimes(1);
    const context = await conversations.context("4", "system");
    expect(context.messages.at(-1)?.content).toBe(delivered);
  });

  it("validates generated output and performs one tool-free recovery", async () => {
    root = await mkdtemp(join(tmpdir(), "turn-"));
    const model = {
      generate: vi
        .fn()
        .mockResolvedValueOnce({
          content: '<tool_calls><invoke name="Search"></invoke></tool_calls>',
        })
        .mockResolvedValueOnce({
          content:
            "已解碼你的請求：「find the answer」。\nRecovered final answer",
        }),
    };
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
      updateId: "701",
      messageId: "2",
      chatId: "3",
      userId: "4",
      text: "find the answer",
    });

    expect(model.generate).toHaveBeenCalledTimes(2);
    expect(model.generate.mock.calls[1]?.[0]).toMatchObject({
      executionMode: "direct",
      generalCapabilities: [],
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "find the answer" },
      ],
    });
    expect(telegram.send).toHaveBeenCalledWith("3", "Recovered final answer");
  });

  it("uses the fixed fallback when recovery also leaks protocol", async () => {
    root = await mkdtemp(join(tmpdir(), "turn-"));
    const model = {
      generate: vi
        .fn()
        .mockResolvedValueOnce({ content: '{"type":"function_call"}' })
        .mockResolvedValueOnce({ content: '<invoke name="Search">' }),
    };
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
      updateId: "702",
      messageId: "2",
      chatId: "3",
      userId: "4",
      text: "find the answer",
    });

    expect(model.generate).toHaveBeenCalledTimes(2);
    expect(telegram.send).toHaveBeenCalledWith(
      "3",
      "I couldn't safely format the full answer. Please rephrase the request and try again.",
    );
    expect(JSON.stringify(telegram.send.mock.calls)).not.toMatch(
      /function_call|<invoke/i,
    );
  });

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

  it("keeps known and unknown commands out of the routing path", async () => {
    root = await mkdtemp(join(tmpdir(), "turn-"));
    const router = { route: vi.fn() };
    const telegram = {
      typing: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
    };
    for (const [index, text] of [
      "/start",
      "/help",
      "/new",
      "/skills",
      "/nope",
    ].entries())
      await new TelegramTurn(
        new LockCoordinator(root),
        new UpdateRepository(root),
        new ConversationService(),
        { generate: vi.fn() },
        telegram,
        "system",
        undefined,
        undefined,
        new SkillResolver(new CapabilityRegistry()),
        [],
        router,
      ).handle({
        kind: "text",
        updateId: `10${index}`,
        messageId: "2",
        chatId: "3",
        userId: "4",
        text,
      });
    expect(router.route).not.toHaveBeenCalled();
  });

  it("reroutes one invalid tool selection and executes direct with no tools", async () => {
    root = await mkdtemp(join(tmpdir(), "turn-"));
    const registry = new CapabilityRegistry([
      {
        scope: "general",
        request: {
          id: "lookup",
          description: "Lookup current facts",
          inputSchema: { type: "object" },
        },
        input: z.object({}),
        execute: async () => ({}),
      },
    ]);
    const router = {
      route: vi
        .fn()
        .mockResolvedValueOnce({
          kind: "tool",
          selectedToolId: "stale-tool",
          confidence: 1,
          rationale: "stale",
        })
        .mockResolvedValueOnce({
          kind: "direct",
          confidence: 1,
          rationale: "No tool needed",
        }),
    };
    const model = { generate: vi.fn(async () => ({ content: "answer" })) };
    await new TelegramTurn(
      new LockCoordinator(root),
      new UpdateRepository(root),
      new ConversationService(),
      model,
      { typing: vi.fn(async () => {}), send: vi.fn(async () => {}) },
      "system",
      undefined,
      undefined,
      new SkillResolver(registry),
      registry.generalRequests(),
      router,
      registry,
    ).handle({
      kind: "text",
      updateId: "200",
      messageId: "2",
      chatId: "3",
      userId: "4",
      text: "hello",
    });
    expect(router.route).toHaveBeenCalledTimes(2);
    expect(model.generate).toHaveBeenCalledWith(
      expect.objectContaining({ generalCapabilities: [] }),
    );
  });

  it("records a shadow decision without executing its selected tool", async () => {
    root = await mkdtemp(join(tmpdir(), "turn-"));
    const capabilities = ["lookup", "calendar"].map((id) => ({
      id,
      description: `${id} capability`,
      inputSchema: { type: "object" },
    }));
    const router = {
      route: vi.fn(async () => ({
        kind: "tool" as const,
        selectedToolId: "lookup",
        confidence: 0.9,
        rationale: "Would select lookup",
      })),
    };
    const model = { generate: vi.fn(async () => ({ content: "answer" })) };
    await new TelegramTurn(
      new LockCoordinator(root),
      new UpdateRepository(root),
      new ConversationService(),
      model,
      { typing: vi.fn(async () => {}), send: vi.fn(async () => {}) },
      "system",
      undefined,
      undefined,
      new SkillResolver(new CapabilityRegistry()),
      capabilities,
      router,
      undefined,
      60_000,
      { mode: "shadow" },
    ).handle({
      kind: "text",
      updateId: "201",
      messageId: "2",
      chatId: "3",
      userId: "4",
      text: "hello",
    });

    expect(router.route).toHaveBeenCalledOnce();
    expect(model.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        executionMode: "forced_web_search",
        generalCapabilities: [],
      }),
    );
  });

  it("enforces a selected skill's prohibited actions before generation", async () => {
    root = await mkdtemp(join(tmpdir(), "turn-"));
    const model = { generate: vi.fn() };
    const telegram = {
      typing: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
    };
    const skills = new SkillResolver(new CapabilityRegistry(), [
      {
        id: "safe-files",
        commitSha: "a".repeat(40),
        name: "Safe files",
        instructions: "Help with files.",
        triggers: { keywords: ["files"], minimumConfidence: 1 },
        tools: [],
        prohibitedActions: ["delete files"],
        visibility: "public",
        ownerTelegramUserIds: ["4"],
        allowedTelegramUserIds: [],
        status: "active",
      },
    ]);
    await new TelegramTurn(
      new LockCoordinator(root),
      new UpdateRepository(root),
      new ConversationService(),
      model,
      telegram,
      "system",
      undefined,
      undefined,
      skills,
    ).handle({
      kind: "text",
      updateId: "7",
      messageId: "2",
      chatId: "3",
      userId: "4",
      text: "delete files",
    });
    expect(model.generate).not.toHaveBeenCalled();
    expect(telegram.send).toHaveBeenCalledWith(
      "3",
      expect.stringContaining("prohibits"),
    );
  });

  it("loads a matched skill into the model request", async () => {
    root = await mkdtemp(join(tmpdir(), "turn-"));
    const model = { generate: vi.fn(async () => ({ content: "forecast" })) };
    const telegram = {
      typing: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
    };
    const skills = new SkillResolver(new CapabilityRegistry(), [
      {
        id: "weather",
        commitSha: "a".repeat(40),
        name: "Weather",
        description: "Weather forecasts",
        instructions: "Use the weather procedure.",
        triggers: { keywords: ["weather"], minimumConfidence: 1 },
        tools: [],
        prohibitedActions: [],
        visibility: "public",
        ownerTelegramUserIds: ["4"],
        allowedTelegramUserIds: [],
        status: "active",
      },
    ]);
    await new TelegramTurn(
      new LockCoordinator(root),
      new UpdateRepository(root),
      new ConversationService(),
      model,
      telegram,
      "system",
      undefined,
      undefined,
      skills,
    ).handle({
      kind: "text",
      updateId: "8",
      messageId: "2",
      chatId: "3",
      userId: "4",
      text: "weather",
    });
    expect(model.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        skill: expect.objectContaining({ id: "weather" }),
      }),
    );
  });

  it("forces native search instead of general capabilities when no skill matches", async () => {
    root = await mkdtemp(join(tmpdir(), "turn-"));
    const model = {
      generate: vi.fn(async (request: unknown) => {
        void request;
        return { content: "general" };
      }),
    };
    const telegram = {
      typing: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
    };
    const registry = new CapabilityRegistry([
      {
        request: {
          id: "lookup",
          description: "Lookup",
          inputSchema: { type: "object" },
        },
        input: z.object({}),
        execute: async () => ({}),
      },
    ]);
    const generalCapabilities = registry.requests(["lookup"]);
    await new TelegramTurn(
      new LockCoordinator(root),
      new UpdateRepository(root),
      new ConversationService(),
      model,
      telegram,
      "system",
      undefined,
      undefined,
      new SkillResolver(registry, []),
      generalCapabilities,
    ).handle({
      kind: "text",
      updateId: "9",
      messageId: "2",
      chatId: "3",
      userId: "4",
      text: "tell me a joke",
    });
    const request = model.generate.mock.calls[0]![0];
    expect(request).not.toHaveProperty("skill");
    expect(request.generalCapabilities).toEqual([]);
    expect(request.executionMode).toBe("forced_web_search");
  });

  it("answers an unknown explicit skill request through the general path", async () => {
    root = await mkdtemp(join(tmpdir(), "turn-"));
    const model = {
      generate: vi.fn(async () => ({ content: "The answer is 42." })),
    };
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
      undefined,
      undefined,
      new SkillResolver(new CapabilityRegistry(), []),
    ).handle({
      kind: "text",
      updateId: "10",
      messageId: "2",
      chatId: "3",
      userId: "4",
      text: "/use missing what is the answer?",
    });
    expect(model.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          { role: "user", content: "what is the answer?" },
        ]),
      }),
    );
    expect(telegram.send).toHaveBeenCalledWith(
      "3",
      expect.stringMatching(/not available[\s\S]*42/),
    );
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
    const assistant = conversations.add(
      "4",
      "assistant",
      "stored final\n\n⚠️ Some defaults were used because the GitHub connection and skill list were unavailable, the built-in emergency prompt was used.",
    );
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
