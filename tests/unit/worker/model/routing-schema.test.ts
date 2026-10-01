import { describe, expect, it } from "vitest";
import {
  routingDecisionSchema,
  routingRequestSchema,
} from "../../../../src/shared/contracts";

const common = { confidence: 0.9, rationale: "A bounded explanation" };

describe("routing schemas", () => {
  it.each([
    { kind: "skill", selectedSkillId: "weather", ...common },
    { kind: "tool", selectedToolId: "calculator", ...common },
    { kind: "web_search_fallback", ...common },
    { kind: "direct", ...common },
    { kind: "ambiguous", candidateIds: ["weather", "travel"], ...common },
    { kind: "refuse", ...common },
    { kind: "unavailable", ...common },
  ])("accepts the valid $kind decision", (decision) => {
    expect(routingDecisionSchema.parse(decision)).toEqual(decision);
  });

  it.each([
    ["extra fields", { kind: "direct", unexpected: true, ...common }],
    [
      "unsupported combinations",
      {
        kind: "skill",
        selectedSkillId: "weather",
        selectedToolId: "lookup",
        ...common,
      },
    ],
    ["missing selected ID", { kind: "skill", ...common }],
    [
      "oversized rationale",
      { kind: "direct", confidence: 1, rationale: "x".repeat(501) },
    ],
    [
      "duplicate ambiguity IDs",
      { kind: "ambiguous", candidateIds: ["weather", "weather"], ...common },
    ],
  ])("rejects %s", (_name, decision) => {
    expect(routingDecisionSchema.safeParse(decision).success).toBe(false);
  });

  it("rejects duplicate catalog IDs", () => {
    const descriptor = {
      id: "weather",
      name: "Weather",
      description: "Weather forecasts",
      status: "active" as const,
      supportedTasks: [],
      triggerHints: [],
      permittedCapabilityIds: [],
    };
    expect(
      routingRequestSchema.safeParse({
        request: "weather",
        conversationContext: [],
        authorizedSkills: [descriptor, descriptor],
        availableTools: [],
      }).success,
    ).toBe(false);
  });
});
