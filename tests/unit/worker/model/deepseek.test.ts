import { describe, expect, it, vi } from "vitest";
import { DeepSeekProvider } from "../../../../src/worker/model/deepseek";
import { retryTransient } from "../../../../src/worker/model/retry";
import { calculateCost } from "../../../../src/worker/model/usage";
describe("model adapter", () => {
  it("sends exact settings and returns final content only", async () => {
    const fetcher = vi.fn(async (...args: unknown[]) => {
      expect(args[0]).toBe("https://example.test/chat/completions");
      return new Response(
        JSON.stringify({
          id: "r",
          choices: [
            { message: { content: "final", reasoning_content: "hidden" } },
          ],
          usage: { prompt_tokens: 2, completion_tokens: 3 },
        }),
      );
    });
    const result = await new DeepSeekProvider(
      { apiKey: "fixture", baseUrl: "https://example.test", thinking: true },
      fetcher as typeof fetch,
    ).generate({ messages: [{ role: "user", content: "hi" }] });
    expect(result).toEqual({
      content: "final",
      requestId: "r",
      usage: { inputTokens: 2, outputTokens: 3 },
    });
    expect(
      (fetcher.mock.calls[0]?.[1] as RequestInit | undefined)?.body,
    ).toContain('"stream":false');
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
});
