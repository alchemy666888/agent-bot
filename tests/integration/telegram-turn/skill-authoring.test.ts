import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LockCoordinator } from "../../../src/worker/locks/coordinator";
import { initializeLayout } from "../../../src/worker/persistence/layout";
import { MemorySkillDefinitionStore } from "../../../src/worker/skills/definition-store";
import { DurableSkillDraftRepository } from "../../../src/worker/skills/repository";
import { SkillAuthoringService } from "../../../src/worker/skills/service";

const AUTHOR = "42";
const COMPLETE_REQUEST = [
  "Create a skill",
  "Name: release-auditor",
  "Tasks: audit software releases",
  "MUST DO: verify signatures",
  "MUST NOT DO: deploy releases",
  "BETTER TO DO: summarize findings",
  "Tools: shell",
].join("\n");

let root = "";
let coordinator: {
  handle(
    userId: string,
    text: string,
    updateId: string,
    languageCode?: string,
  ): Promise<string>;
};
let answers: string[] = [];

// Authoring remains testable as a standalone service; Telegram turns no longer
// invoke it or allow a stored draft to capture ordinary conversation.
function installAuthoringCoordinator(service: typeof coordinator) {
  coordinator = service;
}

afterEach(async () => {
  answers = [];
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

async function fixture(options?: {
  authors?: string[];
  capabilities?: string[];
  definitions?: MemorySkillDefinitionStore;
}) {
  root = await mkdtemp(join(tmpdir(), "telegram-skill-authoring-"));
  await initializeLayout(root);
  const locks = new LockCoordinator(root);
  const definitions = options?.definitions ?? new MemorySkillDefinitionStore();
  const repository = new DurableSkillDraftRepository(root, locks, definitions, {
    authorTelegramUserIds: new Set(options?.authors ?? [AUTHOR]),
    capabilityIds: new Set(options?.capabilities ?? ["shell"]),
  });
  const generator = {
    generateSkillDraft: vi.fn(
      async (draft, feedback?: string) =>
        `---\nname: ${draft.skillName}\ndescription: Audits signed software releases\n---\n\n# Release auditor\n\n- Verify signatures.\n- Never deploy.${feedback ? `\n- Review note: ${feedback}` : ""}`,
    ),
  };
  const service = new SkillAuthoringService(root, repository, generator);
  installAuthoringCoordinator({
    handle: (userId, text, updateId, languageCode) =>
      locks.withUser(userId, () =>
        service.handle(userId, text, updateId, languageCode),
      ),
  });
  return { definitions, locks, repository, generator, service };
}

async function dispatch(
  updateId: string,
  text: string,
  userId = AUTHOR,
  languageCode?: string,
) {
  const response = await coordinator.handle(
    userId,
    text,
    updateId,
    languageCode,
  );
  answers.push(response);
  return response;
}

function sentText(call = answers.length - 1) {
  return answers[call]!;
}

describe("standalone durable skill authoring", () => {
  it("authors, durably revises, explicitly approves, and stores the reviewed version", async () => {
    const { definitions, locks, repository, generator } = await fixture();

    await expect(dispatch("501", COMPLETE_REQUEST)).resolves.toContain(
      "Approve: /skill_approve 1",
    );
    expect(sentText()).toContain("Approve: /skill_approve 1");

    // Recreate the coordinator to prove the next Telegram turn resumes from durable state.
    const recovered = new SkillAuthoringService(root, repository, generator);
    installAuthoringCoordinator({
      handle: (userId, text, updateId, languageCode) =>
        locks.withUser(userId, () =>
          recovered.handle(userId, text, updateId, languageCode),
        ),
    });
    await dispatch("502", "Use a compact Markdown table for the findings");
    expect(sentText()).toContain("revision 2");
    const reviewed = await repository.activeForOwner(AUTHOR);
    expect(reviewed).toMatchObject({
      status: "awaiting_approval",
      revisionNumber: 2,
    });

    await dispatch("503", "/skill_approve 2");
    expect(sentText()).toContain("pending publish");
    const stored = await definitions.getVersion(
      reviewed!.stableId,
      reviewed!.versionId!,
    );
    expect(stored?.instructions).toContain(
      "Review note: Use a compact Markdown table for the findings",
    );
    expect(stored).toMatchObject({
      state: "pending",
      revision: 2,
      manifest: {
        name: "release-auditor",
        revision: 2,
        ownerTelegramUserIds: [AUTHOR],
        tools: ["shell"],
        authoring: { approvedRevision: 2, requestedCapabilities: ["shell"] },
      },
    });
    expect(
      await locks.withUser(AUTHOR, () => repository.activeForOwner(AUTHOR)),
    ).toBeUndefined();
  });

  it("clarifies an explicit Chinese authoring request", async () => {
    const { repository } = await fixture();
    await dispatch("510", "幫我建立一個 AI skill", AUTHOR, "zh-TW");
    expect(sentText()).toContain("還需要一項資料");
    expect(await repository.activeForOwner(AUTHOR)).toMatchObject({
      status: "clarifying",
    });
  });

  it("rejects an unauthorized author", async () => {
    await fixture({ authors: [] });
    await dispatch("520", COMPLETE_REQUEST);
    await expect(dispatch("521", "/skill_approve 1")).rejects.toThrow(
      "SKILL_AUTHOR_NOT_AUTHORIZED",
    );
  });

  it("rejects an unregistered requested capability", async () => {
    await fixture({ capabilities: [] });
    await dispatch("530", COMPLETE_REQUEST);
    await expect(dispatch("531", "/skill_approve 1")).rejects.toThrow(
      "SKILL_CAPABILITY_NOT_REGISTERED",
    );
  });

  it("surfaces a definition store failure without publishing the draft", async () => {
    const definitions = new MemorySkillDefinitionStore();
    definitions.insertDraftVersion = async () => {
      throw new Error("SKILL_STORE_UNAVAILABLE");
    };
    const { repository } = await fixture({ definitions });
    await expect(dispatch("540", COMPLETE_REQUEST)).rejects.toThrow(
      "SKILL_STORE_UNAVAILABLE",
    );
    expect(await repository.activeForOwner(AUTHOR)).toMatchObject({
      status: "analyzing",
    });
  });

  it("requires another revision when a newer version is stored", async () => {
    const { definitions, repository } = await fixture();
    await dispatch("550", COMPLETE_REQUEST);
    const draft = await repository.activeForOwner(AUTHOR);
    const current = await definitions.getVersion(
      draft!.stableId,
      draft!.versionId!,
    );
    await definitions.insertDraftVersion({
      skillId: draft!.stableId,
      name: draft!.skillName!,
      ownerTelegramUserId: AUTHOR,
      visibility: "private",
      expectedRevision: draft!.revisionNumber,
      contentDigest: current!.contentDigest,
      manifest: current!.manifest,
      instructions: current!.instructions,
      createdBy: AUTHOR,
    });
    await dispatch("551", "/skill_approve 1");
    expect(sentText()).toContain("Revision required");
    expect(
      (await definitions.getVersion(draft!.stableId, draft!.versionId!))?.state,
    ).toBe("draft");
    expect(await repository.activeForOwner(AUTHOR)).toMatchObject({
      status: "revision_requested",
    });
  });

  it("deduplicates repeated webhook delivery across coordinator recreation", async () => {
    const { locks, repository, generator } = await fixture();
    await dispatch("560", COMPLETE_REQUEST);
    const recovered = new SkillAuthoringService(root, repository, generator);
    installAuthoringCoordinator({
      handle: (userId, text, updateId, languageCode) =>
        locks.withUser(userId, () =>
          recovered.handle(userId, text, updateId, languageCode),
        ),
    });
    await dispatch("560", COMPLETE_REQUEST);
    expect(generator.generateSkillDraft).toHaveBeenCalledTimes(1);
    expect(await repository.activeForOwner(AUTHOR)).toMatchObject({
      revisionNumber: 1,
    });
    expect(sentText(0)).toBe(sentText(1));
  });

  it("rejects approval from a different Telegram user", async () => {
    const { definitions, repository } = await fixture({
      authors: [AUTHOR, "99"],
    });
    await dispatch("570", COMPLETE_REQUEST);
    await expect(dispatch("571", "/skill_approve 1", "99")).rejects.toThrow(
      "SKILL_DRAFT_NOT_ACTIVE",
    );
    expect(
      definitions.versions.every((version) => version.state === "draft"),
    ).toBe(true);
    expect(await repository.activeForOwner(AUTHOR)).toMatchObject({
      status: "awaiting_approval",
    });
  });
});
