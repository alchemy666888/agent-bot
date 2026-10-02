import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  PostgresSkillAuthoringRepository,
  type SkillDraftGitClient,
} from "../../../../src/server/skills/repository";
import type { SkillDraft } from "../../../../src/worker/skills/types";
import { markdownIdentity } from "../../../../src/worker/skills/markdown";

const HEAD = "a".repeat(40);

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
    branch: "ai/skill-draft",
    baseCommitSha: HEAD,
    latestCommitSha: HEAD,
    skillBlobSha: null,
    manifestBlobSha: null,
    contentDigest: null,
    pullRequestNumber: null,
  };
}

describe("skill revision commit", () => {
  it("publishes model markdown whose frontmatter does not match the skill name", async () => {
    const files = new Map<string, string>();
    const git: SkillDraftGitClient = {
      controlledPrefix: "skills",
      defaultBranch: "main",
      getBranchHead: async () => HEAD,
      createBranch: async (_branch, base) => base,
      readFile: async (path) => ({
        sha: "b".repeat(40),
        content: files.get(path) ?? "",
      }),
      compareCommits: async () => ({ status: "ahead", files: [] }),
      putFile: async (input) => {
        files.set(input.path, input.content);
        return { sha: "c".repeat(40), commitSha: "d".repeat(40) };
      },
      openPullRequest: async () => {
        throw new Error("unused");
      },
      listPullRequests: async () => [],
    };
    const repository = new PostgresSkillAuthoringRepository({} as Pool, git, {
      authorTelegramUserIds: new Set(["42"]),
      capabilityIds: new Set(),
    });
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
    const skill = files.get("skills/ai-skill/SKILL.md") ?? "";
    const manifest = JSON.parse(
      files.get("skills/ai-skill/manifest.json") ?? "{}",
    ) as {
      name: string;
      description: string;
    };

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
