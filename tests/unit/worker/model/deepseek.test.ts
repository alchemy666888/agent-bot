import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
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
      ).generate({ messages: [{ role: "user", content: "x" }] }),
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
      ).generate({ messages: [{ role: "user", content: "x" }] }),
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
      ).generate({ messages: [{ role: "user", content: "x" }] }),
    ).resolves.toMatchObject({
      content: "Clean answer",
      outputRecovery: { triggered: true, succeeded: true },
    });
  });
});
