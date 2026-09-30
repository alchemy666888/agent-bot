import { z } from "zod";
import { CapabilityRegistry } from "./registry";

/** The only place where skill-facing identifiers become executable code. */
export function createCapabilityRegistry(request: typeof fetch = fetch) {
  return new CapabilityRegistry([
    {
      request: {
        id: "web_search",
        description: "Search the public web for current factual information.",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string", minLength: 1 } },
          required: ["query"],
          additionalProperties: false,
        },
      },
      input: z.object({ query: z.string().min(1).max(500) }).strict(),
      timeoutMs: 8_000,
      async execute(value, signal) {
        const { query } = value as { query: string };
        const response = await request(
          `https://api.duckduckgo.com/?format=json&no_html=1&q=${encodeURIComponent(query)}`,
          { signal },
        );
        if (!response.ok)
          throw Object.assign(new Error("WEB_SEARCH_FAILED"), {
            status: response.status,
          });
        const body = (await response.json()) as {
          AbstractText?: string;
          AbstractURL?: string;
          RelatedTopics?: unknown[];
        };
        return {
          summary: body.AbstractText ?? "",
          url: body.AbstractURL ?? "",
          related: (body.RelatedTopics ?? []).slice(0, 5),
        };
      },
    },
  ]);
}

export * from "./registry";
