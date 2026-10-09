import { describe, expect, it, vi } from "vitest";
import { CapabilityRegistry } from "../../../src/worker/capabilities/registry";
import { DeepSeekRouter } from "../../../src/worker/model/deepseek-router";
import { SkillResolver } from "../../../src/worker/skills/resolver";

const skill = (overrides: Record<string, unknown>) => ({
  id: "public-skill",
  versionId: "018f47a2-4cab-7a31-8f5f-4b6f6f2d62d1",
  name: "Public skill",
  description: "Safe routing description",
  instructions: "PRIVATE REPOSITORY INSTRUCTIONS",
  triggers: {
    phrases: ["help me"],
    keywords: ["help"],
    minimumConfidence: 0.5,
  },
  tools: [],
  prohibitedActions: ["SECRET POLICY DETAIL"],
  visibility: "public" as const,
  ownerTelegramUserIds: ["100"],
  allowedTelegramUserIds: [],
  status: "active" as const,
  ...overrides,
});

describe("router catalog authorization contract", () => {
  it("keeps another user's private and restricted shared skills out of the DeepSeek prompt", async () => {
    const resolver = new SkillResolver(new CapabilityRegistry(), [
      skill({
        id: "private-skill",
        visibility: "private",
        ownerTelegramUserIds: ["100"],
      }),
      skill({
        id: "restricted-skill",
        visibility: "shared",
        allowedTelegramUserIds: ["300"],
      }),
      skill({
        id: "allowed-shared",
        visibility: "shared",
        allowedTelegramUserIds: ["200"],
      }),
    ]);
    let body = "";
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      body = String(init?.body);
      return new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            kind: "direct",
            confidence: 1,
            rationale: "No tool needed",
          }),
        }),
      );
    });
    await new DeepSeekRouter(
      { apiKey: "test", baseUrl: "https://deepseek.invalid" },
      fetcher as typeof fetch,
    ).route({
      request: "hello",
      conversationContext: [],
      authorizedSkills: resolver.routingCatalog("200"),
      availableTools: [],
    });

    expect(body).toContain("allowed-shared");
    expect(body).not.toMatch(
      /private-skill|restricted-skill|PRIVATE REPOSITORY|SECRET POLICY|ownerTelegramUserIds/,
    );
  });
});
