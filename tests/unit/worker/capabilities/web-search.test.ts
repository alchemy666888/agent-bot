import { describe, expect, it, vi } from "vitest";
import { createCapabilityRegistry } from "../../../../src/worker/capabilities";

describe("DeepSeek web_search capability", () => {
  it("calls the DeepSeek responses web_search tool", async () => {
    const fetcher = vi.fn(async (...args: unknown[]) => {
      expect(args[0]).toBe("https://api.deepseek.com/responses");
      const init = args[1] as RequestInit;
      expect(init.headers).toMatchObject({
        authorization: "Bearer fixture-key",
      });
      expect(JSON.parse(String(init.body))).toMatchObject({
        model: "deepseek-v4-pro",
        tools: [{ type: "web_search" }],
        tool_choice: { type: "web_search" },
      });
      return new Response(
        JSON.stringify({
          output_text: "Sunny, 28°C.",
          output: [
            {
              type: "web_search_call",
              action: { query: "Hong Kong weather", sources: ["hko.gov.hk"] },
            },
          ],
        }),
      );
    });
    const registry = createCapabilityRegistry(fetcher as typeof fetch, {
      apiKey: "fixture-key",
      baseUrl: "https://api.deepseek.com",
    });
    const result = await registry.invoke(
      "web_search",
      { query: "Hong Kong weather" },
      ["web_search"],
      () => undefined,
    );
    expect(result).toEqual({
      summary: "Sunny, 28°C.",
      searches: [{ query: "Hong Kong weather", sources: ["hko.gov.hk"] }],
    });
  });

  it("sends the search record back when the first response has no answer", async () => {
    const searchCall = { type: "web_search_call", action: { query: "news" } };
    const fetcher = vi.fn(async (...args: unknown[]) => {
      const body = JSON.parse(
        String((args[1] as RequestInit | undefined)?.body),
      ) as { input: unknown; tool_choice: unknown };
      if (typeof body.input === "string")
        return new Response(JSON.stringify({ output: [searchCall] }));
      expect(body.input).toEqual([searchCall]);
      expect(body.tool_choice).toBe("auto");
      return new Response(JSON.stringify({ output_text: "Headline." }));
    });
    const result = await createCapabilityRegistry(fetcher as typeof fetch, {
      apiKey: "fixture-key",
      baseUrl: "https://api.deepseek.com/",
    }).invoke("web_search", { query: "news" }, ["web_search"], () => undefined);
    expect(result).toMatchObject({ summary: "Headline." });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
