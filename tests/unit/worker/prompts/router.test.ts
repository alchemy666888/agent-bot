import { describe, expect, it, vi } from "vitest";
import { PromptMetadataRouter } from "../../../../src/worker/prompts/router";

describe("PromptMetadataRouter", () => {
  it("sends only bounded request text and authorized metadata", async () => {
    const requestId = "019a3c57-b3bd-7000-8000-000000000000";
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body));
      const catalog = JSON.parse(sent.input[1].content);
      expect(catalog.candidates[0]).toEqual({
        id: "research",
        kind: "request",
        scope: "global",
        summary: "Research",
        commands: [],
        phrases: [],
      });
      expect(JSON.stringify(sent)).not.toContain("repositoryPath");
      expect(catalog.request.length).toBe(8192);
      return new Response(
        JSON.stringify({
          output: [
            {
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({
                    requestId,
                    selectedId: "research",
                    confidence: 0.9,
                    reasonCode: "selected",
                  }),
                },
              ],
            },
          ],
        }),
      );
    });
    const router = new PromptMetadataRouter(
      { apiKey: "secret", baseUrl: "https://example.test" },
      fetch as typeof globalThis.fetch,
    );
    await expect(
      router.route({
        request: "x".repeat(10_000),
        routing: {
          requestId,
          candidates: [
            {
              id: "research",
              kind: "request",
              scope: "global",
              summary: "Research",
              commands: [],
              phrases: [],
            },
          ],
        },
      }),
    ).resolves.toMatchObject({ selectedId: "research" });
  });
});
