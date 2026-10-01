import { describe, expect, it, vi } from "vitest";
import { DeepSeekProvider } from "../../../../src/worker/model/deepseek";
import { retryTransient } from "../../../../src/worker/model/retry";
import { calculateCost } from "../../../../src/worker/model/usage";
import { CapabilityRegistry } from "../../../../src/worker/capabilities/registry";
describe("model adapter", () => {
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
    expect(
      JSON.parse(
        String((fetcher.mock.calls[0]?.[1] as RequestInit | undefined)?.body),
      ),
    ).toEqual({
      model: "deepseek-v4-pro",
      stream: false,
      reasoning: { effort: "medium" },
      tools: [{ type: "web_search" }],
      tool_choice: "auto",
      instructions:
        "be helpful\n\nFor questions that depend on current or local facts, such as weather, news, prices, or schedules, use web search before answering. Answer from the search results and include source links. Say that a search returned nothing only when the tool result is actually empty.",
      input: [{ role: "user", content: "hi" }],
    });
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
    ).generate({ messages: [{ role: "user", content: "weather" }] });
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

  it("rejects malformed tool calls", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
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
        ),
    );
    await expect(
      new DeepSeekProvider(
        { apiKey: "x", baseUrl: "https://example.test", thinking: false },
        fetcher as typeof fetch,
      ).generate({ messages: [{ role: "user", content: "x" }] }),
    ).rejects.toThrow("MALFORMED_TOOL_CALL");
  });

  it("denies tool calls not declared by the resolved skill", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
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
        ),
    );
    await expect(
      new DeepSeekProvider(
        { apiKey: "x", baseUrl: "https://example.test", thinking: false },
        fetcher as typeof fetch,
        new CapabilityRegistry(),
      ).generate({ messages: [{ role: "user", content: "x" }] }),
    ).rejects.toThrow("CAPABILITY_DENIED");
  });
});
