import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { PostgresSkillAuthoringRepository } from "../../../../src/server/skills/repository";
import { MemorySkillDefinitionStore } from "../../../../src/worker/skills/definition-store";
import type { SkillDraft } from "../../../../src/worker/skills/types";
import { markdownIdentity } from "../../../../src/worker/skills/markdown";

function draft(): SkillDraft {
  const now = "2026-10-02T00:00:00.000Z";
  return {
    id: "018f3e0c-7b4a-7c2a-8e1a-6b5d4c3b2a10",
    stableId: "018f3e0c-7b4a-7c2a-8e1a-6b5d4c3b2a11",
    ownerTelegramUserId: "42",
    skillName: "ai-skill",
    intendedTasksDomain: "answer release questions",
    mustDo: ["cite sources"],
    mustNotDo: ["deploy"],
    betterToDo: ["be brief"],
    requiredToolsFunctions: [],
    unresolvedQuestions: [],
    draftContent: null,
    revisionNumber: 0,
    status: "analyzing",
    createdAt: now,
    updatedAt: now,
    installedAt: null,
    lastProcessedUpdateId: null,
    lastResponse: null,
    versionId: null,
    contentDigest: null,
  };
}

describe("skill revision commit", () => {
  it("publishes model markdown whose frontmatter does not match the skill name", async () => {
    const definitions = new MemorySkillDefinitionStore();
    const repository = new PostgresSkillAuthoringRepository(
      {} as Pool,
      definitions,
      {
        authorTelegramUserIds: new Set(["42"]),
        capabilityIds: new Set(),
      },
    );
    const model = [
      "```markdown",
      "---",
      'name: "AI Skill"',
      "description: |",
      "  Generated from a Telegram request",
      "---",
      "Follow the constraints.",
      "```",
    ].join("\n");

    const committed = await repository.commitRevision(draft(), model);
    const stored = await definitions.getVersion(
      committed.stableId,
      committed.versionId!,
    );
    const skill = stored?.instructions ?? "";
    const manifest = stored?.manifest ?? { name: "", description: "" };

    expect(markdownIdentity(skill)).toEqual({
      name: "ai-skill",
      description: "Generated from a Telegram request",
    });
    expect(manifest).toMatchObject({
      name: "ai-skill",
      description: "Generated from a Telegram request",
    });
    expect(committed.contentDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(skill).toContain("Follow the constraints.");
  });
});
