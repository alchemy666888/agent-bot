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
    versionId: "018f47a2-4cab-7a31-8f5f-4b6f6f2d62d1",
    name: "Weather",
    instructions: "weather",
    triggers: { keywords: ["weather", "forecast"], minimumConfidence: 0.5 },
    tools: ["lookup"],
    prohibitedActions: [],
    visibility: "public" as const,
    ownerTelegramUserIds: ["1"],
    allowedTelegramUserIds: [],
    status: "active" as const,
  },
  {
    id: "travel",
    versionId: "018f47a2-4cab-7a31-8f5f-4b6f6f2d62d1",
    name: "Travel",
    instructions: "travel",
    triggers: { keywords: ["travel", "forecast"], minimumConfidence: 0.5 },
    tools: ["lookup"],
    prohibitedActions: [],
    visibility: "public" as const,
    ownerTelegramUserIds: ["1"],
    allowedTelegramUserIds: [],
    status: "active" as const,
  },
];

describe("skill resolver", () => {
  it("gives explicit selection precedence", () =>
    expect(
      new SkillResolver(registry(), skills).resolve(
        "/skill travel weather forecast",
        "9",
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
        "9",
      ),
    ).toMatchObject({
      kind: "selected",
      source: "automatic",
      skill: { id: "weather" },
    }));
  it("falls back for unrelated messages", () =>
    expect(
      new SkillResolver(registry(), skills).resolve("tell me a joke", "9"),
    ).toEqual({ kind: "none" }));
  it("includes a confidence score exactly at the configured boundary", () =>
    expect(
      new SkillResolver(registry(), skills).resolve("weather today", "9"),
    ).toMatchObject({
      kind: "selected",
      skill: { id: "weather" },
    }));
  it("reports ambiguity rather than selecting", () =>
    expect(
      new SkillResolver(registry(), skills).resolve("forecast", "9"),
    ).toMatchObject({ kind: "ambiguous" }));
  it("denies undeclared installations", () =>
    expect(
      () =>
        new SkillResolver(registry(), [{ ...skills[0]!, tools: ["shell"] }]),
    ).toThrow("CAPABILITY_NOT_APPROVED"));
  it("does not reveal private skills through explicit or automatic resolution", () => {
    const privateSkill = {
      ...skills[0]!,
      visibility: "private" as const,
      ownerTelegramUserIds: ["1"],
    };
    const resolver = new SkillResolver(registry(), [privateSkill]);
    expect(resolver.resolve("/skill weather", "2")).toEqual({ kind: "none" });
    expect(resolver.resolve("weather forecast", "2")).toEqual({ kind: "none" });
    expect(resolver.resolve("weather forecast", "1")).toMatchObject({
      kind: "selected",
    });
  });
  it("adapts authorized executable skills for discovery and invocation", () => {
    const resolver = new SkillResolver(registry(), [
      { ...skills[0]!, description: "Current weather" },
    ]);
    expect(resolver.commandCatalog("9")).toEqual([
      expect.objectContaining({
        id: "weather",
        name: "weather",
        displayName: "Weather",
        purpose: "Current weather",
        availability: "available",
      }),
    ]);
  });
  it("returns a deterministic, metadata-only routing catalog", () => {
    const resolver = new SkillResolver(registry(), [
      {
        ...skills[0]!,
        description: "Current weather",
        instructions: "SECRET REPOSITORY CONTENT",
        prohibitedActions: ["internal policy"],
      },
    ]);
    const catalog = resolver.routingCatalog("9");
    expect(catalog).toEqual([
      {
        id: "weather",
        name: "Weather",
        description: "Current weather",
        status: "active",
        supportedTasks: [],
        triggerHints: ["weather", "forecast"],
        permittedCapabilityIds: ["lookup"],
      },
    ]);
    expect(JSON.stringify(catalog)).not.toMatch(
      /SECRET|internal policy|ownerTelegram|versionId/,
    );
  });
});
