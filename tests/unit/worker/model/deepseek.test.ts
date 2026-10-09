import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  CLOCK_ONLY_GUIDANCE,
  containsInternalProtocol,
  DeepSeekProvider,
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
      tools: [{ type: "web_search" }],
      tool_choice: "auto",
      input: [{ role: "user", content: "hi" }],
    });
    expect(body.instructions).toContain("be helpful");
    expect(body.instructions).toContain("Never invent");
    expect(body.instructions).toContain("use web search before answering");
  });
  it("continues after a server-side web_search_call until the answer arrives", async () => {
    const searchCall = {
      type: "web_search_call",
      id: "ws1",
      status: "completed",
      action: { query: "Hong Kong weather" },
    };
    let round = 0;
    const fetcher = vi.fn(async (...args: unknown[]) => {
      const body = JSON.parse(
        String((args[1] as RequestInit | undefined)?.body),
      ) as { input: unknown[]; tools: unknown[]; tool_choice: unknown };
      round += 1;
      if (round === 1)
        return new Response(JSON.stringify({ id: "r1", output: [searchCall] }));
      expect(body.input).toEqual([
        { role: "user", content: "weather" },
        searchCall,
      ]);
      expect(body).toMatchObject({
        tools: [{ type: "web_search" }],
        tool_choice: "auto",
      });
      return new Response(
        JSON.stringify({
          id: "r2",
          output_text: "Hong Kong is sunny.",
          usage: { input_tokens: 4, output_tokens: 5 },
        }),
      );
    });
    const result = await new DeepSeekProvider(
      { apiKey: "fixture", baseUrl: "https://example.test", thinking: false },
      fetcher as typeof fetch,
    ).generate({
      executionMode: "forced_web_search",
      messages: [{ role: "user", content: "weather" }],
    });
    const initial = JSON.parse(
      String((fetcher.mock.calls[0]?.[1] as RequestInit | undefined)?.body),
    );
    expect(initial.tool_choice).toEqual({ type: "web_search" });
    expect(result.content).toBe("Hong Kong is sunny.");
    expect(result.capabilityAudit).toEqual([
      {
        capabilityId: "web_search",
        outcome: "success",
        durationMs: expect.any(Number),
      },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("turns a failed forced search into a safe final limitation", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output: [{ type: "web_search_call", id: "ws1", status: "failed" }],
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output_text: "I couldn't verify current information right now.",
          }),
        ),
      );
    const result = await new DeepSeekProvider(
      { apiKey: "fixture", baseUrl: "https://example.test", thinking: false },
      fetcher as typeof fetch,
    ).generate({
      executionMode: "forced_web_search",
      messages: [{ role: "user", content: "latest news" }],
    });
    expect(result).toMatchObject({
      content: "I couldn't verify current information right now.",
      outputRecovery: { triggered: true, succeeded: true },
      capabilityAudit: [{ capabilityId: "web_search", outcome: "failure" }],
    });
    const recoveryBody = JSON.parse(
      String((fetcher.mock.calls[1]?.[1] as RequestInit | undefined)?.body),
    );
    const initialBody = JSON.parse(
      String((fetcher.mock.calls[0]?.[1] as RequestInit | undefined)?.body),
    );
    expect(initialBody).toMatchObject({
      tools: [{ type: "web_search" }],
      tool_choice: { type: "web_search" },
    });
    expect(recoveryBody.tools).toBeUndefined();
    expect(recoveryBody.instructions).toContain(REPLY_STYLE_GUIDANCE);
    expect(recoveryBody.instructions).toContain(
      "failed or produced no useful results",
    );
  });
  it("does not accept a factual answer accompanying a failed forced search", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          output: [{ type: "web_search_call", id: "ws", status: "failed" }],
          output_text: "It is definitely sunny today.",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ output_text: "I could not verify current weather." }),
      );
    const result = await new DeepSeekProvider(
      { apiKey: "fixture", baseUrl: "https://example.test", thinking: false },
      fetcher as typeof fetch,
    ).generate({
      executionMode: "forced_web_search",
      messages: [{ role: "user", content: "weather" }],
    });
    expect(result.content).toBe("I could not verify current weather.");
    expect(result.outputRecovery).toMatchObject({ triggered: true });
  });

  it("searches the current year again when a calendar repeats a prior year", async () => {
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
      expect(body.tool_choice).toEqual({ type: "web_search" });
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

  it("uses DeepSeek web_search instead of a client function with the same name", async () => {
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
      {
        type: "function",
        name: "lookup",
        description: "Lookup",
        parameters: { type: "object" },
      },
      { type: "web_search" },
    ]);
  });
  it("always offers web search when the selected skill does not authorize its compatibility id", async () => {
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
      {
        type: "function",
        name: "lookup",
        description: "Lookup",
        parameters: { type: "object" },
      },
      { type: "web_search" },
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

  it("denies undeclared tool calls and recovers without tools", async () => {
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
    expect(recoveryBody.tools).toBeUndefined();
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
      {
        type: "function",
        name: "lookup",
        description: "Lookup",
        parameters: { type: "object" },
      },
      { type: "web_search" },
    ]);
    expect(initialBody.tool_choice).toBe("auto");
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

  it("bounds repeated native web-search iterations and recovers to final text", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output: [
              { type: "web_search_call", id: "one", status: "completed" },
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output: [
              { type: "web_search_call", id: "two", status: "completed" },
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output_text: "Search could not be completed safely.",
          }),
        ),
      );
    const result = await new DeepSeekProvider(
      {
        apiKey: "x",
        baseUrl: "https://example.test",
        thinking: false,
        maxToolCalls: 1,
      },
      fetcher as typeof fetch,
    ).generate({
      executionMode: "forced_web_search",
      messages: [{ role: "user", content: "latest" }],
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({
      content: "Search could not be completed safely.",
      outputRecovery: { triggered: true, succeeded: true },
    });
    const first = JSON.parse(
      String((fetcher.mock.calls[0]![1] as RequestInit).body),
    );
    expect(first.tool_choice).toEqual({ type: "web_search" });
    const recovery = JSON.parse(
      String((fetcher.mock.calls[2]![1] as RequestInit).body),
    );
    expect(recovery.tools).toBeUndefined();
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

  it("searches a user-specified date instead of the current clock", async () => {
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
      expect(body.tools).toBeUndefined();
      expect(body.instructions).toContain(CLOCK_ONLY_GUIDANCE);
      expect(body.instructions).not.toContain("Answer from the search results");
      return Response.json({ output_text: "現在是 18:48（Asia/Hong_Kong）。" });
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
