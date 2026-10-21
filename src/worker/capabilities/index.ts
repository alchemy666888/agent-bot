import { z } from "zod";
import { CapabilityRegistry } from "./registry";

/** Builds the code-owned registry of skill-facing capability identifiers. */
export function createCapabilityRegistry() {
  return new CapabilityRegistry([
    {
      // Authorization-only compatibility identifier. DeepSeekProvider removes
      // it from function definitions and execution permissions. Search runs
      // natively in the Responses API, never as a registry function.
      scope: "skill",
      request: {
        id: "web_search",
        description:
          "Web research through DeepSeek's provider-native web_search tool, available on every answer request.",
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
