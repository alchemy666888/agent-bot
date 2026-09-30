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
      instructions: "be helpful",
      input: [{ role: "user", content: "hi" }],
    });
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
