import { z } from "zod";
import { CapabilityRegistry } from "./registry";

/** Builds the code-owned registry of skill-facing capability identifiers. */
export function createCapabilityRegistry() {
  return new CapabilityRegistry([
    {
      // Authorization-only compatibility identifier. DeepSeekProvider removes
      // it from both function definitions and execution permissions. Existing
      // stored skills can still load, but search can never execute.
      scope: "skill",
      request: {
        id: "web_search",
        description:
          "Disabled legacy web search capability. Use direct generation and state uncertainty about live facts.",
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
        throw new Error("WEB_SEARCH_DISABLED");
      },
    },
  ]);
}

export * from "./registry";
