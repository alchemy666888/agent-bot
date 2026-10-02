import { describe, expect, it } from "vitest";
import { normalizePromptPath } from "../../../src/server/prompts/schema";

describe("prompt path security contract", () => {
  it("accepts only normalized markdown descendants", () => {
    expect(normalizePromptPath("prompts/common/system/base.md")).toBe(
      "prompts/common/system/base.md",
    );
    for (const segment of [
      "..",
      ".",
      "%2e%2e",
      "%252e%252e",
      "a\\b",
      "a//b",
      "x\0y",
    ])
      expect(() => normalizePromptPath(`prompts/${segment}/x.md`)).toThrow();
  });
});
