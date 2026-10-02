import { describe, expect, it } from "vitest";
import {
  alignSkillMarkdown,
  markdownIdentity,
} from "../../../../src/worker/skills/markdown";

const MODEL_OUTPUT = [
  "```markdown",
  "---",
  'name: "AI Skill"',
  "description: |",
  "  Generated from a Telegram request",
  "---",
  "",
  "# AI Skill",
  "",
  "Follow the constraints.",
  "```",
].join("\n");

describe("skill markdown alignment", () => {
  it("rejects model output whose frontmatter name is not the approved skill name", () => {
    expect(() => markdownIdentity(MODEL_OUTPUT)).toThrow(
      "SKILL_MARKDOWN_MANIFEST_MISMATCH",
    );
  });

  it("rewrites fenced, quoted, and folded model output onto the approved name", () => {
    const aligned = alignSkillMarkdown(
      MODEL_OUTPUT,
      "ai-skill",
      "Custom skill",
    );
    expect(aligned.startsWith("---\nname: ai-skill\n")).toBe(true);
    expect(markdownIdentity(aligned)).toEqual({
      name: "ai-skill",
      description: "Generated from a Telegram request",
    });
    expect(aligned).toContain("Follow the constraints.");
  });

  it("supplies a description when the model omits frontmatter", () => {
    const aligned = alignSkillMarkdown(
      "Just do the task.",
      "reports",
      "Summarize reports",
    );
    expect(markdownIdentity(aligned)).toEqual({
      name: "reports",
      description: "Summarize reports",
    });
    expect(aligned).toContain("Just do the task.");
  });
});
