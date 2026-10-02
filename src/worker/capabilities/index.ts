import { z } from "zod";
import { CapabilityRegistry } from "./registry";

/** Builds the code-owned registry of skill-facing capability identifiers. */
export function createCapabilityRegistry() {
  return new CapabilityRegistry([
    {
      // Authorization-only compatibility identifier. DeepSeekProvider removes
      // it from function definitions and offers native web_search in the
      // primary Responses API request, so this adapter must never make a
      // second model request.
      scope: "skill",
      request: {
        id: "web_search",
        description:
          "Search the public web with DeepSeek web_search for current factual information.",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string", minLength: 1 } },
          required: ["query"],
          additionalProperties: false,
        },
      },
      input: z.object({ query: z.string().min(1).max(500) }).strict(),
      timeoutMs: 45_000,
      async execute() {
        throw new Error("WEB_SEARCH_PROVIDER_NATIVE_ONLY");
      },
    },
  ]);
}

export * from "./registry";
