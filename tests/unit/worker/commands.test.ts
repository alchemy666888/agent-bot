import { describe, expect, it } from "vitest";
import {
  handleCommand,
  normalizeSkillName,
  type InstalledSkill,
} from "../../../src/worker/commands";

const skill = (
  name: string,
  overrides: Partial<InstalledSkill> = {},
): InstalledSkill => ({
  name,
  displayName: name,
  purpose: `Purpose for ${name}`,
  version: "1.0.0",
  availability: "available",
  ...overrides,
});

const reply = (
  text: string,
  catalog: readonly InstalledSkill[] = [],
  userId = "7",
) => {
  const result = handleCommand(text, catalog, userId);
  expect(result?.kind).toBe("reply");
  return result?.kind === "reply" ? result.text : "";
};

describe("skill commands", () => {
  it("handles an empty catalog", () => {
    expect(reply("/skills")).toBe("No skills are installed.");
  });

  it("lists multiple skills with all concise discovery fields", () => {
    const text = reply("/skills", [
      skill("writer", {
        displayName: "Writer",
        purpose: "Draft prose",
        version: "2.1.0",
      }),
      skill("audit", { displayName: "Audit", availability: "unavailable" }),
    ]);
    expect(text).toContain("Writer — Draft prose · v2.1.0 · available");
    expect(text).toContain("Audit — Purpose for audit · v1.0.0 · unavailable");
  });

  it("rejects normalized name collisions deterministically", () => {
    const text = reply("/use STRASSE do it", [
      skill("STRASSE"),
      skill("strasse", { displayName: "Second" }),
    ]);
    expect(text).toMatch(/ambiguous/i);
  });

  it("paginates a stable sorted catalog", () => {
    const catalog = ["f", "e", "d", "c", "b", "a"].map((name) => skill(name));
    const first = reply("/skills", catalog);
    const second = reply("/skills 2", catalog);
    expect(first).toContain("Skills (1/2)");
    expect(first).not.toContain("f —");
    expect(second).toContain("Skills (2/2)\nf —");
    expect(reply("/skills 3", catalog)).toMatch(/does not exist/i);
  });

  it("normalizes and resolves Unicode names", () => {
    expect(normalizeSkillName(" ＣＡＦÉ ")).toBe("café");
    const result = handleCommand(
      "/use CAFÉ résume ceci",
      [skill("café", { displayName: "Café ✨" })],
      "7",
    );
    expect(result).toMatchObject({
      kind: "invoke",
      invocation: { request: "résume ceci", skill: { name: "café" } },
    });
  });

  it("does not disclose restricted detail or allow unauthorized invocation", () => {
    const catalog = [
      skill("private", {
        authorizedUserIds: ["42"],
        operatingConstraints: "secret",
      }),
    ];
    expect(reply("/skill private", catalog)).toMatch(/not authorized/i);
    expect(reply("/use private work", catalog)).toMatch(/not authorized/i);
    expect(reply("/skills", catalog)).toContain("unavailable");
  });

  it("returns detail and gracefully falls back for unavailable skills", () => {
    const catalog = [
      skill("slow", { availability: "unavailable" }),
      skill("old", {
        availability: "retired",
        supportedTasks: ["legacy reports"],
      }),
    ];
    expect(handleCommand("/use slow work", catalog, "7")).toMatchObject({
      kind: "fallback",
      request: "work",
      reason: "skill_unavailable",
    });
    expect(handleCommand("/use old work", catalog, "7")).toMatchObject({
      kind: "fallback",
      request: "work",
      reason: "skill_unavailable",
    });
    expect(reply("/skill old", catalog)).toContain(
      "Supported tasks: legacy reports",
    );
  });

  it("preserves the request when an explicitly requested skill is missing", () => {
    expect(handleCommand("/use missing explain this", [], "7")).toMatchObject({
      kind: "fallback",
      request: "explain this",
      reason: "skill_not_found",
    });
  });
});
