import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LockCoordinator } from "../../../../src/worker/locks/coordinator";
import { initializeLayout } from "../../../../src/worker/persistence/layout";
import { DurableSkillDraftRepository } from "../../../../src/worker/skills/repository";
import {
  isSkillCreationRequest,
  SkillAuthoringService,
} from "../../../../src/worker/skills/service";

let root = "";
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  root = await mkdtemp(join(tmpdir(), "skill-authoring-"));
  await initializeLayout(root);
  const locks = new LockCoordinator(root);
  const files = new Map<string, { content: string; sha: string }>();
  let sequence = 1;
  let head = "0".repeat(40);
  const sha = () => (sequence++).toString(16).padStart(40, "0");
  const git = {
    controlledPrefix: "skills",
    defaultBranch: "main",
    getBranchHead: vi.fn(async () => head),
    createBranch: vi.fn(async (_branch: string, base: string) => base),
    readFile: vi.fn(async (path: string) => files.get(path)!),
    putFile: vi.fn(
      async ({
        path,
        content,
        expectedSha,
      }: {
        path: string;
        content: string;
        expectedSha: string | null;
      }) => {
        expect(files.get(path)?.sha ?? null).toBe(expectedSha);
        const fileSha = sha();
        head = sha();
        files.set(path, { content, sha: fileSha });
        return { sha: fileSha, commitSha: head };
      },
    ),
    openPullRequest: vi.fn(async () => ({
      number: 17,
      html_url: "https://example.test/pull/17",
    })),
  };
  const repository = new DurableSkillDraftRepository(root, locks, git);
  const generator = {
    generateSkillDraft: vi.fn(
      async (draft) =>
        `---\nname: ${draft.skillName}\ndescription: Test skill\n---\n\n# Instructions`,
    ),
  };
  return {
    locks,
    repository,
    generator,
    service: new SkillAuthoringService(root, repository, generator),
    git,
  };
}

describe("skill authoring domain", () => {
  it("detects explicit creation requests and asks one focused missing-constraint question", async () => {
    const { locks, repository, service } = await fixture();
    expect(isSkillCreationRequest("Please create a skill called audits")).toBe(
      true,
    );
    const response = await locks.withUser("42", () =>
      service.handle(
        "42",
        "Create a skill called audits\nTasks: audit releases",
        "1",
      ),
    );
    expect(response).toContain("MUST");
    expect(await repository.activeForOwner("42")).toMatchObject({
      ownerTelegramUserId: "42",
      skillName: "audits",
      status: "clarifying",
      mustDo: [],
      mustNotDo: [],
      betterToDo: [],
      revisionNumber: 0,
    });
  });

  it("persists constraints, creates revisions, rejects stale approval, and installs current approval", async () => {
    const { locks, repository, generator, service } = await fixture();
    const initial =
      "Create a skill\nName: release-auditor\nTasks: audit releases\nMUST DO: verify signatures\nMUST NOT DO: deploy\nBETTER TO DO: summarize findings\nTools: shell";
    const first = await locks.withUser("42", () =>
      service.handle("42", initial, "1"),
    );
    expect(first).toContain("/skill_approve ");
    const revised = await locks.withUser("42", () =>
      service.handle("42", "Also check provenance", "2"),
    );
    expect(revised).toContain("revision 2");
    expect(generator.generateSkillDraft).toHaveBeenLastCalledWith(
      expect.anything(),
      "Also check provenance",
    );
    const revisedAgain = await locks.withUser("42", () =>
      service.handle("42", "Use a compact result table", "20"),
    );
    expect(revisedAgain).toContain("revision 3");
    const stale = await locks.withUser("42", () =>
      service.handle("42", "/skill_approve 1", "3"),
    );
    expect(stale).toContain("exact draft");
    const current = await repository.activeForOwner("42");
    const command = `/skill_approve ${current!.id} ${current!.revisionNumber} ${current!.latestCommitSha} ${current!.contentDigest}`;
    const installed = await locks.withUser("42", () =>
      service.handle("42", command, "4"),
    );
    expect(installed).toContain("pull request");
    expect(await repository.activeForOwner("42")).toBeUndefined();
    // A fresh worker replaying the same update returns the durable response
    // instead of creating a second installation.
    const recovered = new SkillAuthoringService(root, repository, generator);
    expect(
      await locks.withUser("42", () => recovered.handle("42", command, "4")),
    ).toBe(installed);
  });

  it("cancels without generating a draft", async () => {
    const { locks, repository, generator, service } = await fixture();
    await locks.withUser("7", () =>
      service.handle("7", "Create a skill", "10"),
    );
    expect(
      await locks.withUser("7", () =>
        service.handle("7", "/skill_cancel", "11"),
      ),
    ).toContain("cancelled");
    expect(await repository.activeForOwner("7")).toBeUndefined();
    expect(generator.generateSkillDraft).not.toHaveBeenCalled();
  });
});
