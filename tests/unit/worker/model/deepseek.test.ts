import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  CLOCK_ONLY_GUIDANCE,
  containsInternalProtocol,
  DeepSeekProvider,
  SAFE_OUTPUT_FALLBACK,
} from "../../../../src/worker/model/deepseek";
import { retryTransient } from "../../../../src/worker/model/retry";
import { REPLY_STYLE_GUIDANCE } from "../../../../src/worker/model/reply-style";
import { calculateCost } from "../../../../src/worker/model/usage";
import { CapabilityRegistry } from "../../../../src/worker/capabilities/registry";
describe("model adapter", () => {
  it.each([
    "direct",
    "forced_web_search",
    "selected_tools",
    "selected_skill",
  ] as const)("applies reply style in %s mode", async (executionMode) => {
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.instructions).toContain(REPLY_STYLE_GUIDANCE);
      return Response.json({ output_text: "Useful answer" });
    });
    await new DeepSeekProvider(
      { apiKey: "fixture", baseUrl: "https://example.test", thinking: false },
      fetcher as typeof fetch,
    ).generate({
      executionMode,
      messages: [{ role: "user", content: "hello" }],
      ...(executionMode === "selected_skill"
        ? {
            skill: {
              id: "example",
              version: "1",
              instructions: "Help with the request",
              capabilities: [],
              prohibitedActions: [],
            },
          }
        : {}),
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([
    "direct",
    "forced_web_search",
    "selected_tools",
    "selected_skill",
  ] as const)(
    "always offers provider-native search without forcing it in %s mode",
    async (executionMode) => {
      const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        expect(body.tools).toEqual([{ type: "web_search" }]);
        expect(body.tool_choice).toBe("auto");
        expect(body.instructions).toContain(
          "Provider-native web search is always available",
        );
        return Response.json({
          output_text:
            "Please share the CPI figures and BTC price for a conditional analysis.",
        });
      });
      await new DeepSeekProvider(
        { apiKey: "fixture", baseUrl: "https://example.test", thinking: false },
        fetcher as typeof fetch,
      ).generate({
        executionMode,
        messages: [
          { role: "user", content: "CPI數據出來了，BTC有沒有交易機會" },
        ],
      });
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  it.each([
    '<tool_calls><invoke name="Search"></invoke></tool_calls>',
    '<invoke name="Search">',
    '{"type":"function_call","name":"Search","arguments":"{}"}',
    '<tool_calls><invoke name="Search"',
    '这是搜索结果之前的说明。\n<tool_calls><invoke name="Search"></invoke></tool_calls>',
    '{"output":[{"type":"web_search_call","id":"ws_1","status":"completed"}]}',
    '{"function_call":{"name":"Search","arguments":"{}"}}',
    '{"tool_calls":[{"type":"function","function":{"name":"Search"}}]}',
    '{"type":"function_call_output","call_id":"call_1","output":"ok"}',
  ])("recognizes leaked protocol fixture %s", (fixture) => {
    expect(containsInternalProtocol(fixture)).toBe(true);
  });

  it.each([
    "The Responses API has a web_search_call output type.",
    "A function_call is different from an ordinary JavaScript function call.",
    "Use an XML <example> element when documenting the payload.",
    "The parameter should be a string.",
  ])("allows ordinary technical discussion %s", (fixture) => {
    expect(containsInternalProtocol(fixture)).toBe(false);
  });

  it("sends exact settings and returns final content only", async () => {
    const fetcher = vi.fn(async (...args: unknown[]) => {
      expect(args[0]).toBe("https://example.test/responses");
      return new Response(
        JSON.stringify({
          id: "r",
          output: [
            {
              type: "reasoning",
              content: [{ type: "reasoning_text", text: "hidden" }],
            },
            {
              type: "message",
              content: [{ type: "output_text", text: "final" }],
            },
          ],
          usage: { input_tokens: 2, output_tokens: 3 },
        }),
      );
    });
    const result = await new DeepSeekProvider(
      { apiKey: "fixture", baseUrl: "https://example.test", thinking: true },
      fetcher as typeof fetch,
    ).generate({
      executionMode: "direct",
      messages: [
        { role: "system", content: "be helpful" },
        { role: "user", content: "hi" },
      ],
    });
    expect(result).toEqual({
      content: "final",
      requestId: "r",
      usage: { inputTokens: 2, outputTokens: 3 },
    });
    const body = JSON.parse(
      String((fetcher.mock.calls[0]?.[1] as RequestInit | undefined)?.body),
    );
    expect(body).toMatchObject({
      model: "deepseek-v4-pro",
      stream: false,
      reasoning: { effort: "medium" },
      input: [{ role: "user", content: "hi" }],
    });
    expect(body.instructions).toContain("be helpful");
    expect(body.instructions).toContain("Never invent");
    expect(body.instructions).toContain(
      "Provider-native web search is always available",
    );
    expect(body.tools).toEqual([{ type: "web_search" }]);
    expect(body.tool_choice).toBe("auto");
  });
  it.each(["failed", "in_progress"])(
    "recovers from %s search output without replaying unusable results",
    async (status) => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({
            id: "r1",
            output: [{ type: "web_search_call", id: "ws1", status }],
            output_text: "It is definitely sunny today.",
            usage: { input_tokens: 2, output_tokens: 3 },
          }),
        )
        .mockResolvedValueOnce(
          Response.json({
            id: "r2",
            output_text: "Please share the current weather data.",
            usage: { input_tokens: 4, output_tokens: 5 },
          }),
        );
      const result = await new DeepSeekProvider(
        { apiKey: "fixture", baseUrl: "https://example.test", thinking: false },
        fetcher as typeof fetch,
      ).generate({
        executionMode: "direct",
        messages: [{ role: "user", content: "weather" }],
      });
      expect(result).toMatchObject({
        content: "Please share the current weather data.",
        usage: { inputTokens: 6, outputTokens: 8 },
        outputRecovery: { triggered: true, succeeded: true },
      });
      expect(result.capabilityAudit).toBeUndefined();
      expect(fetcher).toHaveBeenCalledTimes(2);
      for (const [, init] of fetcher.mock.calls) {
        const body = JSON.parse(String(init?.body));
        expect(body.tools).toEqual([{ type: "web_search" }]);
        expect(body.tool_choice).toBe("auto");
        expect(JSON.stringify(body.input)).not.toContain("web_search_call");
      }
    },
  );

  it.each(["direct", "forced_web_search"] as const)(
    "surfaces provider errors without a search recovery in %s mode",
    async (executionMode) => {
      const fetcher = vi.fn(async () =>
        Response.json(
          {
            error: { message: "Unavailable" },
          },
          { status: 503 },
        ),
      );
      await expect(
        new DeepSeekProvider(
          {
            apiKey: "fixture",
            baseUrl: "https://example.test",
            thinking: false,
          },
          fetcher as typeof fetch,
        ).generate({
          executionMode,
          messages: [{ role: "user", content: "latest news" }],
        }),
      ).rejects.toMatchObject({
        message: "DEEPSEEK_REQUEST_FAILED",
        status: 503,
      });
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  it("delivers completed search text and source URLs without another request", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(
      Response.json({
        id: "searched",
        output: [
          { type: "web_search_call", id: "ws1", status: "completed" },
          {
            type: "reasoning",
            content: [{ type: "reasoning_text", text: "private" }],
          },
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: "Source: https://example.org/report",
              },
            ],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 20 },
      }),
    );
    const result = await new DeepSeekProvider(
      { apiKey: "fixture", baseUrl: "https://example.test", thinking: false },
      fetcher,
    ).generate({
      executionMode: "direct",
      messages: [{ role: "user", content: "latest report" }],
    });
    expect(result).toEqual({
      content: "Source: https://example.org/report",
      requestId: "searched",
      usage: { inputTokens: 10, outputTokens: 20 },
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("replays search-only results and accumulates usage within the existing loop", async () => {
    const search = {
      type: "web_search_call",
      id: "ws1",
      status: "completed",
      action: { query: "report" },
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          output: [search],
          usage: { input_tokens: 10, output_tokens: 2 },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          output_text: "Verified report.",
          usage: { input_tokens: 15, output_tokens: 3 },
        }),
      );
    const result = await new DeepSeekProvider(
      { apiKey: "fixture", baseUrl: "https://example.test", thinking: false },
      fetcher,
    ).generate({
      executionMode: "direct",
      messages: [{ role: "user", content: "latest report" }],
    });
    expect(result).toMatchObject({
      content: "Verified report.",
      usage: { inputTokens: 25, outputTokens: 5 },
    });
    expect(result.outputRecovery).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
    const continuation = JSON.parse(String(fetcher.mock.calls[1]![1]!.body));
    expect(continuation.input).toContainEqual(search);
    expect(continuation.tools).toEqual([{ type: "web_search" }]);
    expect(continuation.tool_choice).toBe("auto");
  });

  it("reuses completed research during recovery and keeps search available", async () => {
    const search = { type: "web_search_call", id: "ws1", status: "completed" };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          output: [
            search,
            {
              type: "message",
              role: "assistant",
              content: '<tool_calls><invoke name="lookup"',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          output: [{ type: "web_search_call", id: "ws2", status: "completed" }],
          output_text: "Verified answer.",
        }),
      );
    const result = await new DeepSeekProvider(
      { apiKey: "fixture", baseUrl: "https://example.test", thinking: false },
      fetcher,
    ).generate({
      executionMode: "selected_tools",
      generalCapabilities: [
        {
          id: "lookup",
          description: "Lookup",
          inputSchema: { type: "object" },
        },
      ],
      messages: [{ role: "user", content: "latest report" }],
    });
    expect(result).toMatchObject({
      content: "Verified answer.",
      outputRecovery: { triggered: true, succeeded: true },
    });
    const recovery = JSON.parse(String(fetcher.mock.calls[1]![1]!.body));
    expect(recovery.input).toContainEqual(search);
    expect(JSON.stringify(recovery.input)).not.toContain("<tool_calls>");
    expect(recovery.tools).toEqual([{ type: "web_search" }]);
    expect(recovery.tool_choice).toBe("auto");
  });

  it("bounds search-only continuations and rejects search-only recovery", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({
        output: [{ type: "web_search_call", id: "ws", status: "completed" }],
      }),
    );
    const result = await new DeepSeekProvider(
      {
        apiKey: "fixture",
        baseUrl: "https://example.test",
        thinking: false,
        maxToolCalls: 1,
      },
      fetcher,
    ).generate({
      executionMode: "direct",
      messages: [{ role: "user", content: "latest report" }],
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({
      content: SAFE_OUTPUT_FALLBACK,
      outputRecovery: { triggered: true, succeeded: false },
    });
  });

  it("corrects a draft about another place with native search available", async () => {
    const request = "今天香港有什麼新聞";
    const malaysia =
      "今日（10月12日）馬來西亞主要新聞如下：吉隆坡綜合指數上升。";
    const hongKong = "今日香港主要新聞：立法會復會。";
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        instructions: string;
        tool_choice: unknown;
        input: { content?: string }[];
      };
      if (fetcher.mock.calls.length === 1) {
        expect(body.instructions).toContain("Hong Kong");
        expect(body.tool_choice).toBe("auto");
        return Response.json({ output_text: malaysia });
      }
      expect(body.tool_choice).toBe("auto");
      expect(body.input.at(-1)?.content).toContain("Hong Kong");
      return Response.json({ output_text: hongKong });
    });
    const result = await new DeepSeekProvider(
      {
        apiKey: "fixture",
        baseUrl: "https://example.test",
        thinking: false,
        now: () => new Date("2026-10-12T06:55:00.000Z"),
        timeZone: "Asia/Hong_Kong",
      },
      fetcher as typeof fetch,
    ).generate({
      executionMode: "direct",
      messages: [{ role: "user", content: request }],
    });
    expect(result.content).toBe(hongKong);
    expect(result.content).not.toContain("吉隆坡");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("withholds another place's news when the retry is still wrong", async () => {
    const malaysia =
      "今日（10月12日）馬來西亞主要新聞如下：吉隆坡綜合指數上升。";
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ output_text: malaysia }))
      .mockResolvedValueOnce(Response.json({ output_text: malaysia }))
      .mockResolvedValueOnce(
        Response.json({ output_text: "香港今日的新聞核實不到。" }),
      );
    const result = await new DeepSeekProvider(
      {
        apiKey: "fixture",
        baseUrl: "https://example.test",
        thinking: false,
        now: () => new Date("2026-10-12T06:55:00.000Z"),
        timeZone: "Asia/Hong_Kong",
      },
      fetcher as typeof fetch,
    ).generate({
      executionMode: "direct",
      messages: [{ role: "user", content: "今天香港有什麼新聞" }],
    });
    expect(result.content).toBe("香港今日的新聞核實不到。");
    expect(result.content).not.toContain("吉隆坡");
    expect(result.outputRecovery).toMatchObject({
      triggered: true,
      succeeded: true,
    });
  });

  it("corrects a stale calendar with native search available", async () => {
    const request = "下個星期有什麼會議或者事件需要交易者注意的嗎？";
    const stale =
      "週一（10/13）\n美聯儲主席鮑威爾在 NABE 年會發表演說，談經濟展望與貨幣政策，是利率預期的關鍵";
    const current = "週二（10/13）\n這週沒有確認到鮑威爾的 NABE 演說。";
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        instructions: string;
        tool_choice: unknown;
        input: { content: string }[];
      };
      if (fetcher.mock.calls.length === 1) {
        expect(body.instructions).toContain("current_year: 2026");
        expect(body.tool_choice).toBe("auto");
        return Response.json({ output_text: stale });
      }
      expect(body.tool_choice).toBe("auto");
      expect(body.input.at(-1)?.content).toContain("2026");
      return Response.json({ output_text: current });
    });
    const result = await new DeepSeekProvider(
      {
        apiKey: "fixture",
        baseUrl: "https://example.test",
        thinking: false,
        now: () => new Date("2026-10-09T06:41:00.000Z"),
        timeZone: "Asia/Hong_Kong",
      },
      fetcher as typeof fetch,
    ).generate({
      executionMode: "direct",
      messages: [{ role: "user", content: request }],
    });
    expect(result.content).toBe(current);
    expect(result.content).not.toContain("週一（10/13）");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("withholds a calendar that is still from the prior year after a retry", async () => {
    const stale =
      "週一（10/13）\n美聯儲主席鮑威爾在 NABE 年會發表演說，談經濟展望與貨幣政策，是利率預期的關鍵";
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ output_text: stale }))
      .mockResolvedValueOnce(Response.json({ output_text: stale }))
      .mockResolvedValueOnce(
        Response.json({
          output_text: "I couldn't verify the current week's events.",
        }),
      );
    const result = await new DeepSeekProvider(
      {
        apiKey: "fixture",
        baseUrl: "https://example.test",
        thinking: false,
        now: () => new Date("2026-10-09T06:41:00.000Z"),
        timeZone: "Asia/Hong_Kong",
      },
      fetcher as typeof fetch,
    ).generate({
      executionMode: "direct",
      messages: [
        {
          role: "user",
          content: "下個星期有什麼會議或者事件需要交易者注意的嗎？",
        },
      ],
    });
    expect(result.content).toBe("I couldn't verify the current week's events.");
    expect(result.content).not.toContain("鮑威爾");
    expect(result.outputRecovery).toMatchObject({
      triggered: true,
      succeeded: true,
    });
  });

  it("offers native search without duplicating the legacy search function", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            output_text: "done",
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        ),
    );
    await new DeepSeekProvider(
      { apiKey: "fixture", baseUrl: "https://example.test", thinking: false },
      fetcher as typeof fetch,
    ).generate({
      executionMode: "selected_skill",
      messages: [{ role: "user", content: "news" }],
      skill: {
        id: "news",
        version: "1",
        instructions: "Look up news",
        prohibitedActions: [],
        capabilities: [
          {
            id: "web_search",
            description: "Search",
            inputSchema: { type: "object" },
          },
          {
            id: "lookup",
            description: "Lookup",
            inputSchema: { type: "object" },
          },
        ],
      },
    });
    expect(
      JSON.parse(
        String((fetcher.mock.calls[0]?.[1] as RequestInit | undefined)?.body),
      ).tools,
    ).toEqual([
      { type: "web_search" },
      {
        type: "function",
        name: "lookup",
        description: "Lookup",
        parameters: { type: "object" },
      },
    ]);
  });
  it("denies a legacy search function even when the selected skill declares it", async () => {
    const execute = vi.fn(async () => ({ results: [] }));
    const registry = new CapabilityRegistry([
      {
        request: {
          id: "web_search",
          description: "Legacy search",
          inputSchema: { type: "object" },
        },
        input: z.object({}),
        execute,
      },
    ]);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          output: [
            {
              type: "function_call",
              name: "web_search",
              call_id: "ws1",
              arguments: "{}",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ output_text: "Please provide the current figures." }),
      );
    const result = await new DeepSeekProvider(
      { apiKey: "x", baseUrl: "https://example.test", thinking: false },
      fetcher,
      registry,
    ).generate({
      executionMode: "selected_skill",
      messages: [{ role: "user", content: "latest news" }],
      skill: {
        id: "news",
        version: "1",
        instructions: "Summarize the news",
        capabilities: registry.requests(["web_search"]),
        prohibitedActions: [],
      },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      content: "Please provide the current figures.",
      capabilityAudit: [{ capabilityId: "web_search", outcome: "denied" }],
    });
    for (const [, init] of fetcher.mock.calls) {
      expect(JSON.parse(String(init?.body)).tools).toEqual([
        { type: "web_search" },
      ]);
    }
  });

  it("offers native search alongside authorized function tools for a selected skill", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            output_text: "done",
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        ),
    );
    await new DeepSeekProvider(
      { apiKey: "fixture", baseUrl: "https://example.test", thinking: false },
      fetcher as typeof fetch,
    ).generate({
      executionMode: "selected_skill",
      messages: [{ role: "user", content: "news" }],
      skill: {
        id: "calc",
        version: "1",
        instructions: "Calculate",
        prohibitedActions: [],
        capabilities: [
          {
            id: "lookup",
            description: "Lookup",
            inputSchema: { type: "object" },
          },
        ],
      },
    });
    const body = JSON.parse(
      String((fetcher.mock.calls[0]?.[1] as RequestInit | undefined)?.body),
    ) as { tools: { type: string }[]; instructions: string };
    expect(body.tools).toEqual([
      { type: "web_search" },
      {
        type: "function",
        name: "lookup",
        description: "Lookup",
        parameters: { type: "object" },
      },
    ]);
    expect(body.tool_choice).toBe("auto");
    expect(body.instructions).toMatch(/web search/);
  });
  it("retries transient errors only twice", async () => {
    const fn = vi.fn(async () => {
      throw new Error("x");
    });
    await expect(
      retryTransient(
        fn,
        () => true,
        async () => {},
      ),
    ).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(3);
  });
  it("calculates exact decimal costs", () =>
    expect(
      calculateCost(1_000_000, 500_000, "1.25", "2.00").estimatedCost,
    ).toBe("2.250000"));

  it("recovers from malformed tool calls without exposing protocol", async () => {
    let calls = 0;
    const fetcher = vi.fn(async () => {
      calls++;
      return calls === 1
        ? new Response(
            JSON.stringify({
              output: [
                {
                  type: "function_call",
                  name: "lookup",
                  call_id: "1",
                  arguments: "{",
                },
              ],
            }),
          )
        : new Response(
            JSON.stringify({
              output_text: "A direct, safe answer",
            }),
          );
    });
    await expect(
      new DeepSeekProvider(
        { apiKey: "x", baseUrl: "https://example.test", thinking: false },
        fetcher as typeof fetch,
      ).generate({
        executionMode: "direct",
        messages: [{ role: "user", content: "x" }],
      }),
    ).resolves.toMatchObject({
      content: "A direct, safe answer",
      outputRecovery: { triggered: true, succeeded: true },
    });
  });

  it("denies undeclared tool calls and recovers without function tools", async () => {
    let calls = 0;
    const fetcher = vi.fn(async () => {
      calls++;
      return calls === 1
        ? new Response(
            JSON.stringify({
              output: [
                {
                  type: "function_call",
                  name: "lookup",
                  call_id: "1",
                  arguments: "{}",
                },
              ],
            }),
          )
        : new Response(JSON.stringify({ output_text: "No-tool answer" }));
    });
    await expect(
      new DeepSeekProvider(
        { apiKey: "x", baseUrl: "https://example.test", thinking: false },
        fetcher as typeof fetch,
        new CapabilityRegistry(),
      ).generate({
        executionMode: "direct",
        messages: [{ role: "user", content: "x" }],
      }),
    ).resolves.toMatchObject({
      content: "No-tool answer",
      capabilityAudit: [{ capabilityId: "lookup", outcome: "denied" }],
      outputRecovery: { triggered: true, succeeded: true },
    });
    const recoveryBody = JSON.parse(
      String((fetcher.mock.calls[1]?.[1] as RequestInit | undefined)?.body),
    );
    expect(recoveryBody.tools).toEqual([{ type: "web_search" }]);
  });

  it("uses a safe general capability and returns the tool-informed answer", async () => {
    const registry = new CapabilityRegistry([
      {
        request: {
          id: "lookup",
          description: "Lookup",
          inputSchema: { type: "object" },
        },
        input: z.object({}),
        execute: async () => ({ temperature: 28 }),
      },
    ]);
    let calls = 0;
    const fetcher = vi.fn(async () => {
      calls++;
      return calls === 1
        ? new Response(
            JSON.stringify({
              output: [
                { type: "web_search_call", id: "ws", status: "completed" },
                {
                  type: "function_call",
                  name: "lookup",
                  call_id: "1",
                  arguments: "{}",
                },
              ],
            }),
          )
        : new Response(JSON.stringify({ output_text: "It is 28°C." }));
    });
    await expect(
      new DeepSeekProvider(
        { apiKey: "x", baseUrl: "https://example.test", thinking: false },
        fetcher as typeof fetch,
        registry,
      ).generate({
        executionMode: "selected_tools",
        messages: [{ role: "user", content: "weather?" }],
        generalCapabilities: registry.requests(["lookup"]),
      }),
    ).resolves.toMatchObject({
      content: "It is 28°C.",
      capabilityAudit: [{ capabilityId: "lookup", outcome: "success" }],
    });
    const initialBody = JSON.parse(
      String((fetcher.mock.calls[0]![1] as RequestInit).body),
    );
    expect(initialBody.tools).toEqual([
      { type: "web_search" },
      {
        type: "function",
        name: "lookup",
        description: "Lookup",
        parameters: { type: "object" },
      },
    ]);
    expect(initialBody.tool_choice).toBe("auto");
    const continuation = JSON.parse(
      String((fetcher.mock.calls[1]![1] as RequestInit).body),
    );
    expect(continuation.input).toContainEqual({
      type: "web_search_call",
      id: "ws",
      status: "completed",
    });
    expect(continuation.input).toContainEqual({
      type: "function_call_output",
      call_id: "1",
      output: JSON.stringify({ temperature: 28 }),
    });
  });

  it("retries once when final text leaks raw tool protocol", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output_text:
              '<tool_calls><invoke name="search"></invoke></tool_calls>',
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ output_text: "Clean answer" })),
      );
    await expect(
      new DeepSeekProvider(
        { apiKey: "x", baseUrl: "https://example.test", thinking: false },
        fetcher as typeof fetch,
      ).generate({
        executionMode: "direct",
        messages: [{ role: "user", content: "x" }],
      }),
    ).resolves.toMatchObject({
      content: "Clean answer",
      outputRecovery: { triggered: true, succeeded: true },
    });
  });

  it("extracts only final message text and never reasoning", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            output: [
              {
                type: "reasoning",
                content: [{ type: "reasoning_text", text: "hidden rationale" }],
              },
              {
                type: "message",
                content: [
                  { type: "output_text", text: "First. " },
                  { type: "output_text", text: "Second." },
                ],
              },
            ],
          }),
        ),
    );
    const result = await new DeepSeekProvider(
      { apiKey: "x", baseUrl: "https://example.test", thinking: true },
      fetcher as typeof fetch,
    ).generate({
      executionMode: "direct",
      messages: [{ role: "user", content: "answer" }],
    });
    expect(result.content).toBe("First. Second.");
    expect(result.content).not.toContain("hidden rationale");
  });

  it("uses recovery without function tools for empty output", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ output: [] }))
      .mockResolvedValueOnce(Response.json({ output_text: "Useful answer" }));
    const result = await new DeepSeekProvider(
      { apiKey: "x", baseUrl: "https://example.test", thinking: false },
      fetcher as typeof fetch,
    ).generate({
      executionMode: "direct",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(result.content).toBe("Useful answer");
    expect(result.outputRecovery).toEqual({ triggered: true, succeeded: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const recovery = JSON.parse(String(fetcher.mock.calls[1]![1]!.body));
    expect(recovery.tools).toEqual([{ type: "web_search" }]);
  });

  it("records model progress before the provider request", async () => {
    const notes: string[] = [];
    const fetcher = vi.fn(async () =>
      Response.json({ output_text: "Useful answer" }),
    );
    await new DeepSeekProvider(
      { apiKey: "fixture", baseUrl: "https://example.test", thinking: false },
      fetcher as typeof fetch,
      undefined,
      async (progress) => {
        notes.push(`${progress.stage}:${progress.tool ?? ""}`);
      },
    ).generate({
      executionMode: "forced_web_search",
      messages: [{ role: "user", content: "CPI" }],
    });
    expect(notes).toEqual(["model:"]);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("forwards caller aborts to the provider request", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );
    const pending = new DeepSeekProvider(
      { apiKey: "x", baseUrl: "https://example.test", thinking: false },
      fetcher as typeof fetch,
    ).generate({
      executionMode: "direct",
      messages: [{ role: "user", content: "x" }],
      signal: controller.signal,
    });
    controller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow("cancelled");
  });

  it.each(["direct", "forced_web_search"] as const)(
    "bounds body reads without a search recovery in %s mode",
    async (executionMode) => {
      const cancel = vi.fn(async () => {});
      const fetcher = vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            json: () => new Promise(() => undefined),
            body: { cancel },
          }) as unknown as Response,
      );
      await expect(
        new DeepSeekProvider(
          {
            apiKey: "x",
            baseUrl: "https://example.test",
            thinking: false,
            requestTimeoutMs: 10,
          },
          fetcher as typeof fetch,
        ).generate({
          executionMode,
          messages: [{ role: "user", content: "CPI BTC" }],
        }),
      ).rejects.toThrow("PROVIDER_REQUEST_TIMEOUT");
      expect(fetcher).toHaveBeenCalledOnce();
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("uses a user-specified date instead of the current clock", async () => {
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { instructions: string };
      expect(body.instructions).toContain("current_year: 2026");
      expect(body.instructions).toContain("2024-03-15 15:00");
      expect(body.instructions).toContain("user-specified date and time");
      return Response.json({ output_text: "2024年3月15日的新聞摘要。" });
    });
    const result = await new DeepSeekProvider(
      {
        apiKey: "fixture",
        baseUrl: "https://example.test",
        thinking: false,
        now: () => new Date("2026-10-09T06:41:00.000Z"),
        timeZone: "Asia/Hong_Kong",
      },
      fetcher as typeof fetch,
    ).generate({
      executionMode: "forced_web_search",
      messages: [{ role: "user", content: "2024年3月15日下午3點的新聞" }],
    });
    expect(result.content).toContain("2024年3月15日");
  });

  it.each(["direct", "forced_web_search"] as const)(
    "bounds a %s request even when fetch ignores abort",
    async (executionMode) => {
      const fetcher = vi.fn<typeof fetch>(
        () => new Promise<Response>(() => undefined),
      );
      await expect(
        new DeepSeekProvider(
          {
            apiKey: "x",
            baseUrl: "https://example.test",
            thinking: false,
            requestTimeoutMs: 10,
          },
          fetcher,
        ).generate({
          executionMode,
          messages: [{ role: "user", content: "hello" }],
        }),
      ).rejects.toThrow("PROVIDER_REQUEST_TIMEOUT");
      expect(fetcher).toHaveBeenCalledOnce();
      expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    },
  );

  it("returns safe text when recovery without function tools times out", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ output: [] }))
      .mockImplementationOnce(() => new Promise<Response>(() => undefined));
    const result = await new DeepSeekProvider(
      {
        apiKey: "x",
        baseUrl: "https://example.test",
        thinking: false,
        requestTimeoutMs: 10,
      },
      fetcher,
    ).generate({
      executionMode: "direct",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(result.content).toBe(SAFE_OUTPUT_FALLBACK);
    expect(result.outputRecovery).toEqual({
      triggered: true,
      succeeded: false,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("bounds error-body reads and does not wait for body cancellation", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const fetcher = vi.fn(
      async () =>
        ({
          ok: false,
          status: 503,
          text: () => new Promise<string>(() => undefined),
          body: { cancel },
        }) as unknown as Response,
    );
    await expect(
      new DeepSeekProvider(
        {
          apiKey: "x",
          baseUrl: "https://example.test",
          thinking: false,
          requestTimeoutMs: 10,
        },
        fetcher as typeof fetch,
      ).generate({
        executionMode: "direct",
        messages: [{ role: "user", content: "hello" }],
      }),
    ).rejects.toThrow("PROVIDER_REQUEST_TIMEOUT");
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("keeps an injected news-mcp clock instead of the server clock", async () => {
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { instructions: string };
      expect(body.instructions).toContain("current_date: 2024-01-02");
      expect(body.instructions).toContain("current_hour: 8");
      expect(body.instructions).toContain("current_minute: 5");
      expect(body.instructions).toContain("news-mcp");
      expect(body.instructions).not.toContain("current_date: 2026-10-09");
      return Response.json({ output_text: "ok" });
    });
    await new DeepSeekProvider(
      {
        apiKey: "fixture",
        baseUrl: "https://example.test",
        thinking: false,
        now: () => new Date("2026-10-09T06:41:00.000Z"),
        timeZone: "Asia/Hong_Kong",
      },
      fetcher as typeof fetch,
    ).generate({
      executionMode: "direct",
      trustedInstructions: [
        { source: "runtime", content: "current_date: 2024-01-02" },
        { source: "runtime", content: "current_year: 2024" },
        { source: "runtime", content: "current_month: 1" },
        { source: "runtime", content: "current_day: 2" },
        { source: "runtime", content: "current_hour: 8" },
        { source: "runtime", content: "current_minute: 5" },
        { source: "runtime", content: "weekday: Tuesday" },
        { source: "runtime", content: "timezone: Asia/Hong_Kong" },
        { source: "runtime", content: "clock_source: news_mcp" },
      ],
      messages: [{ role: "user", content: "今天的新聞" }],
    });
  });

  it("does not force web search for a pure time question", async () => {
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        instructions: string;
        tools?: unknown;
        tool_choice?: unknown;
      };
      expect(body.tool_choice).not.toEqual({ type: "web_search" });
      expect(body.tools).toEqual([{ type: "web_search" }]);
      expect(body.instructions).toContain(CLOCK_ONLY_GUIDANCE);
      expect(body.instructions).not.toContain("Answer from the search results");
      return Response.json({ output_text: "現在是香港時間18:48。" });
    });
    await new DeepSeekProvider(
      {
        apiKey: "fixture",
        baseUrl: "https://example.test",
        thinking: false,
        now: () => new Date("2026-10-09T10:48:00.000Z"),
        timeZone: "Asia/Hong_Kong",
      },
      fetcher as typeof fetch,
    ).generate({
      executionMode: "forced_web_search",
      messages: [{ role: "user", content: "現在幾點" }],
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
