import { describe, expect, it, vi } from "vitest";
import { DeepSeekRouter } from "../../../../src/worker/model/deepseek-router";

const request = {
  request: "help",
  conversationContext: [],
  authorizedSkills: [
    {
      id: "weather",
      name: "Weather",
      description: "Forecasts",
      status: "active" as const,
      supportedTasks: ["forecast"],
      triggerHints: ["weather"],
      permittedCapabilityIds: ["lookup"],
    },
  ],
  availableTools: [
    { id: "lookup", description: "Lookup", inputSchema: { type: "object" } },
  ],
};
const response = (value: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(value), init);

describe("DeepSeek router adapter", () => {
  it.each([
    {
      kind: "skill",
      selectedSkillId: "weather",
      confidence: 1,
      rationale: "explicit skill",
    },
    {
      kind: "tool",
      selectedToolId: "lookup",
      confidence: 0.9,
      rationale: "general tool",
    },
    {
      kind: "web_search_fallback",
      confidence: 0.8,
      rationale: "current facts",
    },
    { kind: "direct", confidence: 0.8, rationale: "known answer" },
    {
      kind: "ambiguous",
      candidateIds: ["weather", "lookup"],
      confidence: 0.5,
      rationale: "clarify",
    },
    { kind: "refuse", confidence: 1, rationale: "unsafe" },
    { kind: "unavailable", confidence: 1, rationale: "cannot act" },
  ])("parses and instruments $kind", async (decision) => {
    const fetcher = vi.fn(async () =>
      response({
        id: "route-1",
        output_text: JSON.stringify(decision),
        usage: { input_tokens: 3, output_tokens: 4 },
      }),
    );
    const result = await new DeepSeekRouter(
      { apiKey: "x", baseUrl: "https://example.test" },
      fetcher as typeof fetch,
    ).routeWithMetadata(request);
    expect(result.decision).toEqual(decision);
    expect(result.run).toMatchObject({
      requestId: "route-1",
      routeKind: decision.kind,
      validationOutcome: "valid",
      usage: { inputTokens: 3, outputTokens: 4 },
    });
    const body = JSON.parse(
      String((fetcher.mock.calls[0]![1] as RequestInit).body),
    );
    expect(body.input[0].content).not.toContain("instructions");
    expect(body.text.format.strict).toBe(true);
  });

  it.each([
    ["malformed JSON", "{"],
    [
      "extra fields",
      JSON.stringify({
        kind: "direct",
        confidence: 1,
        rationale: "x",
        extra: true,
      }),
    ],
    [
      "oversized output",
      JSON.stringify({
        kind: "direct",
        confidence: 1,
        rationale: "x".repeat(501),
      }),
    ],
    [
      "duplicate IDs",
      JSON.stringify({
        kind: "ambiguous",
        candidateIds: ["weather", "weather"],
        confidence: 1,
        rationale: "x",
      }),
    ],
    [
      "unsupported combination",
      JSON.stringify({
        kind: "tool",
        selectedToolId: "lookup",
        selectedSkillId: "weather",
        confidence: 1,
        rationale: "x",
      }),
    ],
  ])("rejects %s as invalid output", async (_name, output_text) => {
    const router = new DeepSeekRouter(
      { apiKey: "x", baseUrl: "https://example.test" },
      vi.fn(async () => response({ output_text })) as typeof fetch,
    );
    await expect(router.route(request)).rejects.toMatchObject({
      message: "ROUTER_OUTPUT_INVALID",
      run: { fallbackReason: "invalid_response" },
    });
  });

  it.each([429, 500, 503])(
    "surfaces HTTP %s as a provider error",
    async (status) => {
      const router = new DeepSeekRouter(
        { apiKey: "x", baseUrl: "https://example.test" },
        vi.fn(async () => response({}, { status })) as typeof fetch,
      );
      await expect(router.route(request)).rejects.toMatchObject({
        message: "DEEPSEEK_ROUTING_FAILED",
        status,
        run: { fallbackReason: "provider_error" },
      });
    },
  );

  it("classifies timeout and caller abort separately as failed requests", async () => {
    const abortingFetch = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );
    const timed = new DeepSeekRouter(
      { apiKey: "x", baseUrl: "https://example.test", timeoutMs: 5 },
      abortingFetch as typeof fetch,
    );
    await expect(timed.route(request)).rejects.toMatchObject({
      run: { fallbackReason: "timeout" },
    });
    const controller = new AbortController();
    const aborted = new DeepSeekRouter(
      { apiKey: "x", baseUrl: "https://example.test", timeoutMs: 10_000 },
      abortingFetch as typeof fetch,
    ).route({ ...request, signal: controller.signal });
    controller.abort();
    await expect(aborted).rejects.toMatchObject({
      run: { fallbackReason: "provider_error" },
    });
  });
});
