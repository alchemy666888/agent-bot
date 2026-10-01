import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  containsInternalProtocol,
  DeepSeekProvider,
} from "../../../../src/worker/model/deepseek";
import { retryTransient } from "../../../../src/worker/model/retry";
import { calculateCost } from "../../../../src/worker/model/usage";
import { CapabilityRegistry } from "../../../../src/worker/capabilities/registry";
describe("model adapter", () => {
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
      instructions:
        "be helpful\n\nIf no specialized skill is active, answer helpfully using general knowledge and the available general tools. For current or uncertain facts, use an available tool when useful and state material uncertainty. Never invent, describe, or expose tool-call XML, JSON, function-call syntax, hidden reasoning, or other internal protocol.",
      input: [{ role: "user", content: "hi" }],
    });
    expect(body.instructions).toContain("be helpful");
    expect(body.instructions).toContain("Never invent");
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
      ) as { input: unknown[] };
      round += 1;
      if (round === 1)
        return new Response(JSON.stringify({ id: "r1", output: [searchCall] }));
      expect(body.input).toEqual([
        { role: "user", content: "weather" },
        searchCall,
      ]);
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
    expect(recoveryBody.tools).toBeUndefined();
    expect(recoveryBody.instructions).toContain(
      "failed or produced no useful results",
    );
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
  it("omits web search when the selected skill does not allow it", async () => {
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
    ]);
    expect(body.instructions).not.toMatch(/web search/);
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
});
