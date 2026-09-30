import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  const repository = new DurableSkillDraftRepository(root, locks);
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
    expect(first).toContain("/skill_approve 1");
    const revised = await locks.withUser("42", () =>
      service.handle("42", "Also check provenance", "2"),
    );
    expect(revised).toContain("/skill_approve 2");
    expect(generator.generateSkillDraft).toHaveBeenLastCalledWith(
      expect.anything(),
      "Also check provenance",
    );
    const revisedAgain = await locks.withUser("42", () =>
      service.handle("42", "Use a compact result table", "20"),
    );
    expect(revisedAgain).toContain("/skill_approve 3");
    const stale = await locks.withUser("42", () =>
      service.handle("42", "/skill_approve 1", "3"),
    );
    expect(stale).toContain("stale");
    const installed = await locks.withUser("42", () =>
      service.handle("42", "/skill_approve 3", "4"),
    );
    expect(installed).toContain("Installed");
    expect(await repository.activeForOwner("42")).toBeUndefined();
    expect(
      await readFile(join(root, "skills/release-auditor/SKILL.md"), "utf8"),
    ).toContain("name: release-auditor");
    // A fresh worker replaying the same update returns the durable response
    // instead of creating a second installation.
    const recovered = new SkillAuthoringService(root, repository, generator);
    expect(
      await locks.withUser("42", () =>
        recovered.handle("42", "/skill_approve 3", "4"),
      ),
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
