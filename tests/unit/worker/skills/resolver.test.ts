import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CapabilityRegistry } from "../../../../src/worker/capabilities/registry";
import { SkillResolver } from "../../../../src/worker/skills/resolver";

const registry = () =>
  new CapabilityRegistry([
    {
      request: {
        id: "lookup",
        description: "Lookup",
        inputSchema: { type: "object" },
      },
      input: z.object({}),
      execute: async () => ({ ok: true }),
    },
  ]);
const skills = [
  {
    id: "weather",
    version: "1",
    instructions: "weather",
    triggers: { keywords: ["weather", "forecast"], minimumConfidence: 0.5 },
    tools: ["lookup"],
  },
  {
    id: "travel",
    version: "2",
    instructions: "travel",
    triggers: { keywords: ["travel", "forecast"], minimumConfidence: 0.5 },
    tools: ["lookup"],
  },
];

describe("skill resolver", () => {
  it("gives explicit selection precedence", () =>
    expect(
      new SkillResolver(registry(), skills).resolve(
        "/skill travel weather forecast",
      ),
    ).toMatchObject({
      kind: "selected",
      source: "explicit",
      skill: { id: "travel" },
    }));
  it("automatically selects only a sufficiently relevant skill", () =>
    expect(
      new SkillResolver(registry(), skills).resolve(
        "weather forecast tomorrow",
      ),
    ).toMatchObject({
      kind: "selected",
      source: "automatic",
      skill: { id: "weather" },
    }));
  it("falls back for unrelated messages", () =>
    expect(
      new SkillResolver(registry(), skills).resolve("tell me a joke"),
    ).toEqual({ kind: "none" }));
  it("reports ambiguity rather than selecting", () =>
    expect(
      new SkillResolver(registry(), skills).resolve("forecast"),
    ).toMatchObject({ kind: "ambiguous" }));
  it("denies undeclared installations", () =>
    expect(
      () =>
        new SkillResolver(registry(), [{ ...skills[0]!, tools: ["shell"] }]),
    ).toThrow("CAPABILITY_NOT_APPROVED"));
});
