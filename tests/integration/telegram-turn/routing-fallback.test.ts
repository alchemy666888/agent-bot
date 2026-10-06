import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { LockCoordinator } from "../../../src/worker/locks/coordinator";
import { UpdateRepository } from "../../../src/worker/updates/repository";
import { ConversationService } from "../../../src/worker/conversations/service";
import { CapabilityRegistry } from "../../../src/worker/capabilities/registry";
import { DeepSeekProvider } from "../../../src/worker/model/deepseek";
import { TelegramTurn } from "../../../src/worker/orchestration/telegram-turn";
import { SkillResolver } from "../../../src/worker/skills/resolver";
import { skillCatalogSnapshotSchema } from "../../../src/worker/skills/schemas";
import type {
  ModelRequest,
  RoutingDecision,
} from "../../../src/shared/contracts";

let root = "";
const WEATHER_ID = "018f47a2-4cab-7a31-8f5f-4b6f6f2d62d0";

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("skill routing acceptance", () => {
  it("answers a weather question through forced Responses web search with routing disabled", async () => {
    root = await mkdtemp(join(tmpdir(), "routing-native-fallback-"));
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        output: [{ type: "web_search_call", id: "ws", status: "completed" }],
        output_text: "香港目前晴朗。來源：https://weather.example/hong-kong",
      }),
    );
    const telegram = {
      typing: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
    };
    await new TelegramTurn(
      new LockCoordinator(root),
      new UpdateRepository(root),
      new ConversationService(),
      new DeepSeekProvider(
        { apiKey: "fixture", baseUrl: "https://example.test", thinking: false },
        fetcher as typeof fetch,
      ),
      telegram,
      "Be helpful.",
      undefined,
      undefined,
      new SkillResolver(new CapabilityRegistry(), []),
    ).handle({ ...input("27"), text: "今天香港天氣怎樣？" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0]![0])).toBe(
      "https://example.test/responses",
    );
    const body = JSON.parse(
      String((fetcher.mock.calls[0]![1] as RequestInit).body),
    );
    expect(body).toMatchObject({
      tools: [{ type: "web_search" }],
      tool_choice: { type: "web_search" },
    });
    expect(body.input.at(-1).content).toBe("今天香港天氣怎樣？");
    expect(telegram.send).toHaveBeenCalledWith(
      "3",
      "香港目前晴朗。來源：https://weather.example/hong-kong",
    );
  });

  it("loads a catalog, invokes its capability, and sends only final text", async () => {
    root = await mkdtemp(join(tmpdir(), "routing-"));
    const commitSha = "a".repeat(40);
    const catalog = skillCatalogSnapshotSchema.parse({
      commitSha,
      skills: [
        {
          id: "018f47a2-4cab-7a31-8f5f-4b6f6f2d62d0",
          commitSha,
          name: "Weather",
          description: "Answer current weather questions",
          instructions: "Use the lookup result to answer.",
          triggers: { phrases: ["current weather"], minimumConfidence: 1 },
          tools: ["lookup"],
          prohibitedActions: [],
          visibility: "public",
          ownerTelegramUserIds: ["4"],
          allowedTelegramUserIds: [],
          status: "active",
        },
      ],
    });
    const capabilities = new CapabilityRegistry([
      {
        request: {
          id: "lookup",
          description: "Lookup weather",
          inputSchema: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
        input: z.object({ city: z.string() }),
        execute: async () => ({ city: "Hong Kong", temperatureC: 28 }),
      },
    ]);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output: [
              {
                type: "function_call",
                name: "lookup",
                call_id: "weather-1",
                arguments: '{"city":"Hong Kong"}',
              },
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output_text: "Hong Kong is currently 28°C.",
          }),
        ),
      );
    const telegram = {
      typing: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
    };
    await new TelegramTurn(
      new LockCoordinator(root),
      new UpdateRepository(root),
      new ConversationService(),
      new DeepSeekProvider(
        { apiKey: "test", baseUrl: "https://example.test", thinking: false },
        fetcher as typeof fetch,
        capabilities,
      ),
      telegram,
      "Be helpful.",
      undefined,
      undefined,
      new SkillResolver(capabilities, catalog.skills),
      [],
    ).handle({
      kind: "text",
      updateId: "11",
      messageId: "2",
      chatId: "3",
      userId: "4",
      text: "current weather in Hong Kong",
    });
    expect(telegram.send).toHaveBeenCalledWith(
      "3",
      "Hong Kong is currently 28°C.",
    );
    expect(JSON.stringify(telegram.send.mock.calls)).not.toMatch(
      /tool_calls|function_call|invoke/i,
    );
  });

  it.each([
    [
      "skill selection",
      {
        kind: "skill",
        selectedSkillId: WEATHER_ID,
        confidence: 1,
        rationale: "match",
      },
      "selected_skill",
    ],
    [
      "general-tool selection",
      {
        kind: "tool",
        selectedToolId: "lookup",
        confidence: 1,
        rationale: "tool",
      },
      "forced_web_search",
    ],
    [
      "forced native web search",
      { kind: "web_search_fallback", confidence: 1, rationale: "fresh" },
      "forced_web_search",
    ],
    [
      "search fallback for a direct classification",
      { kind: "direct", confidence: 1, rationale: "general" },
      "forced_web_search",
    ],
  ] as const)(
    "runs a full turn for %s",
    async (_label, decision, expectedMode) => {
      root = await mkdtemp(join(tmpdir(), "routing-mode-"));
      const registry = new CapabilityRegistry([
        {
          scope: "general",
          request: {
            id: "lookup",
            description: "Lookup",
            inputSchema: { type: "object" },
          },
          input: z.object({}),
          execute: async () => ({ safe: true }),
        },
      ]);
      const resolver = new SkillResolver(registry, [
        skillFixture(WEATHER_ID, "public"),
      ]);
      const seen: ModelRequest[] = [];
      const model = {
        generate: vi.fn(async (request: ModelRequest) => {
          seen.push(request);
          return {
            content: "Final natural-language answer.",
            requestId: "answer-1",
            usage: { inputTokens: 7, outputTokens: 8 },
          };
        }),
      };
      const router = { route: vi.fn(async () => decision) };
      const telegram = {
        typing: vi.fn(async () => {}),
        send: vi.fn(async () => {}),
      };
      await turn(root, model, telegram, resolver, registry, router).handle(
        input("21"),
      );
      expect(seen).toHaveLength(1);
      expect(seen[0]!.executionMode).toBe(expectedMode);
      expect(telegram.send).toHaveBeenCalledOnce();
      expect(telegram.send).toHaveBeenCalledWith(
        "3",
        "Final natural-language answer.",
      );
      expect(JSON.stringify(telegram.send.mock.calls)).not.toMatch(
        /routing|rationale|function_call|tool_calls|capability/i,
      );
    },
  );

  it("asks a natural-language clarification without invoking the answer model", async () => {
    root = await mkdtemp(join(tmpdir(), "routing-ambiguous-"));
    const registry = new CapabilityRegistry([
      {
        scope: "general",
        request: { id: "lookup", description: "Lookup", inputSchema: {} },
        input: z.object({}),
        execute: async () => ({}),
      },
    ]);
    const model = { generate: vi.fn() };
    const telegram = {
      typing: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
    };
    const decision = {
      kind: "ambiguous",
      candidateIds: [WEATHER_ID, "lookup"],
      confidence: 0.5,
      rationale: "two matches",
    } as const;
    await turn(
      root,
      model,
      telegram,
      new SkillResolver(registry, [skillFixture(WEATHER_ID, "public")]),
      registry,
      { route: async () => decision },
    ).handle(input("22"));
    expect(model.generate).not.toHaveBeenCalled();
    expect(telegram.send).toHaveBeenCalledWith(
      "3",
      `I need clarification. Would you like ${WEATHER_ID} or lookup?`,
    );
  });

  it("forces native web search when routing fails", async () => {
    root = await mkdtemp(join(tmpdir(), "routing-failure-"));
    const model = {
      generate: vi.fn(async (request: ModelRequest) => ({
        content: `Fallback ${request.executionMode}`,
      })),
    };
    const telegram = {
      typing: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
    };
    await turn(root, model, telegram, undefined, new CapabilityRegistry(), {
      route: async () => {
        throw Object.assign(new Error("down"), { status: 503 });
      },
    }).handle(input("23"));
    expect(model.generate).toHaveBeenCalledTimes(1);
    expect(telegram.send).toHaveBeenCalledWith(
      "3",
      "Fallback forced_web_search",
    );
  });

  it("rejects an unknown model-selected ID and permits only one bounded reroute", async () => {
    root = await mkdtemp(join(tmpdir(), "routing-unknown-"));
    const model = {
      generate: vi.fn(async (request: ModelRequest) => ({
        content: `Safe ${request.executionMode} answer`,
      })),
    };
    const telegram = {
      typing: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
    };
    const router = {
      route: vi
        .fn()
        .mockResolvedValueOnce({
          kind: "skill",
          selectedSkillId: "unknown-id",
          confidence: 1,
          rationale: "invalid selection",
        })
        .mockResolvedValueOnce({
          kind: "direct",
          confidence: 1,
          rationale: "bounded recovery",
        }),
    };
    await turn(
      root,
      model,
      telegram,
      undefined,
      new CapabilityRegistry(),
      router,
    ).handle(input("231"));
    expect(router.route).toHaveBeenCalledTimes(2);
    expect(model.generate).toHaveBeenCalledWith(
      expect.objectContaining({ executionMode: "forced_web_search" }),
    );
    expect(model.generate.mock.calls[0]![0]).not.toHaveProperty("skill");
    expect(telegram.send).toHaveBeenCalledWith(
      "3",
      "Safe forced_web_search answer",
    );
  });

  it("turns no useful native-search results into final text only", async () => {
    root = await mkdtemp(join(tmpdir(), "routing-no-results-"));
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output: [{ type: "web_search_call", id: "ws", status: "failed" }],
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output_text: "I couldn't verify current information.",
          }),
        ),
      );
    const telegram = {
      typing: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
    };
    const routerDecision = {
      kind: "web_search_fallback",
      confidence: 1,
      rationale: "current",
    } as const;
    await turn(
      root,
      new DeepSeekProvider(
        { apiKey: "x", baseUrl: "https://example.test", thinking: false },
        fetcher as typeof fetch,
      ),
      telegram,
      undefined,
      new CapabilityRegistry(),
      { route: async () => routerDecision },
    ).handle(input("24"));
    expect(telegram.send).toHaveBeenCalledWith(
      "3",
      "I couldn't verify current information.",
    );
    expect(JSON.stringify(telegram.send.mock.calls)).not.toMatch(
      /web_search_call|status|failed/i,
    );
  });

  it("observes shadow routing without allowing it to alter execution", async () => {
    root = await mkdtemp(join(tmpdir(), "routing-shadow-"));
    const model = {
      generate: vi.fn(async (request: ModelRequest) => ({
        content: `Executed ${request.executionMode}`,
      })),
    };
    const telegram = {
      typing: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
    };
    const router = {
      routeWithMetadata: vi.fn(async () => ({
        decision: {
          kind: "web_search_fallback",
          confidence: 1,
          rationale: "shadow only",
        } as const,
        run: {
          requestId: "shadow-route",
          latencyMs: 1,
          routeKind: "web_search_fallback" as const,
          validationOutcome: "valid" as const,
        },
      })),
      route: vi.fn(),
    };
    const subject = new TelegramTurn(
      new LockCoordinator(root),
      new UpdateRepository(root),
      new ConversationService(),
      model,
      telegram,
      "Be helpful.",
      undefined,
      undefined,
      undefined,
      [],
      router,
      new CapabilityRegistry(),
      60_000,
      { mode: "shadow" },
    );
    await subject.handle(input("25"));
    expect(router.routeWithMetadata).toHaveBeenCalledOnce();
    expect(model.generate).toHaveBeenCalledWith(
      expect.objectContaining({ executionMode: "forced_web_search" }),
    );
    expect(telegram.send).toHaveBeenCalledWith(
      "3",
      "Executed forced_web_search",
    );
  });

  it("accounts for correlated routing and answer usage and does not redeliver a completed retry", async () => {
    root = await mkdtemp(join(tmpdir(), "routing-accounting-"));
    const conversations = new ConversationService();
    const records: Record<string, unknown>[] = [];
    const store = {
      contact: conversations.contact.bind(conversations),
      newConversation: conversations.newConversation.bind(conversations),
      add: conversations.add.bind(conversations),
      context: conversations.context.bind(conversations),
      message: conversations.message.bind(conversations),
      recordModelRun: async (record: Record<string, unknown>) => {
        records.push(record);
      },
    };
    const model = {
      generate: vi.fn(async () => ({
        content: "One final answer.",
        requestId: "answer-request",
        usage: { inputTokens: 11, outputTokens: 12 },
      })),
    };
    let attempts = 0;
    const telegram = {
      typing: vi.fn(async () => {}),
      send: vi.fn(async () => {
        attempts++;
        if (attempts < 3)
          throw Object.assign(new Error("rate limited"), { status: 429 });
      }),
    };
    const router = {
      routeWithMetadata: vi.fn(async () => ({
        decision: {
          kind: "direct",
          confidence: 1,
          rationale: "answer directly",
        } as const,
        run: {
          requestId: "router-request",
          usage: { inputTokens: 2, outputTokens: 3 },
          latencyMs: 1,
          routeKind: "direct" as const,
          validationOutcome: "valid" as const,
        },
      })),
      route: vi.fn(),
    };
    const subject = new TelegramTurn(
      new LockCoordinator(root),
      new UpdateRepository(root),
      store,
      model,
      telegram,
      "Be helpful.",
      undefined,
      {
        thinkingEnabled: false,
        inputPricePerMillion: "1",
        outputPricePerMillion: "2",
      },
      undefined,
      [],
      router,
      new CapabilityRegistry(),
    );
    await subject.handle(input("26"));
    await subject.handle(input("26"));
    expect(records).toHaveLength(2);
    expect(records.map(({ runKind }) => runKind)).toEqual(["router", "answer"]);
    expect(records[0]).toMatchObject({
      providerRequestId: "router-request",
      inputCount: 2,
      outputCount: 3,
    });
    expect(records[1]).toMatchObject({
      providerRequestId: "answer-request",
      inputCount: 11,
      outputCount: 12,
    });
    expect(records[0]!.requestMessageId).toBe(records[1]!.requestMessageId);
    expect(model.generate).toHaveBeenCalledOnce();
    expect(telegram.send).toHaveBeenCalledTimes(3);
  });
});

function input(updateId: string) {
  return {
    kind: "text" as const,
    updateId,
    messageId: "2",
    chatId: "3",
    userId: "4",
    text: "please help",
  };
}

function skillFixture(id: string, visibility: "public" | "private") {
  return skillCatalogSnapshotSchema.parse({
    commitSha: "b".repeat(40),
    skills: [
      {
        id,
        commitSha: "b".repeat(40),
        name: "Weather",
        description: "Forecasts",
        instructions: "Answer safely.",
        triggers: { phrases: [], minimumConfidence: 1 },
        tools: [],
        prohibitedActions: [],
        visibility,
        ownerTelegramUserIds: visibility === "private" ? ["99"] : ["4"],
        allowedTelegramUserIds: [],
        status: "active",
      },
    ],
  }).skills[0]!;
}

function turn(
  directory: string,
  model: ConstructorParameters<typeof TelegramTurn>[3],
  telegram: ConstructorParameters<typeof TelegramTurn>[4],
  resolver: SkillResolver | undefined,
  registry: CapabilityRegistry,
  router: { route(request: unknown): Promise<RoutingDecision> },
) {
  return new TelegramTurn(
    new LockCoordinator(directory),
    new UpdateRepository(directory),
    new ConversationService(),
    model,
    telegram,
    "Be helpful.",
    undefined,
    undefined,
    resolver,
    [],
    router,
    registry,
  );
}
