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
    compareCommits: vi.fn(async () => ({
      status: "ahead",
      files: [...files.keys()].map((path) => ({ path, status: "added" })),
    })),
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
    listPullRequests: vi.fn(async () => []),
  };
  const repository = new DurableSkillDraftRepository(root, locks, git, {
    authorTelegramUserIds: new Set(["42", "7"]),
    capabilityIds: new Set(["shell"]),
  });
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
  it.each([
    ["幫我建立一個 AI skill", true],
    ["請建立一個能整理會議紀錄的 AI skill", true],
    ["請創建 AI skill", true],
    ["幫我生成一個 AI 技能", true],
    ["請製作 AI skill", true],
    ["安裝這個 AI skill", true],
    ["请创建一个 AI skill", true],
    ["帮我生成一个 AI 技能", true],
    ["请制作 AI skill", true],
    ["请安装这个 AI skill", true],
    ["Please create a skill called audits", true],
    ["Build me a new AI skill", true],
    ["Install a skill", true],
    ["如何建立 skill？", false],
    ["怎么创建 AI skill？", false],
    ["How do I create a skill?", false],
    ["Explain how to build a skill", false],
    ["This article discusses skill creation", false],
  ])("classifies %j as creation intent=%s", (text, expected) => {
    expect(isSkillCreationRequest(text)).toBe(expected);
  });

  it("uses languageCode only to localize structured clarification", async () => {
    const { locks, repository, service } = await fixture();
    const response = await locks.withUser("42", () =>
      service.handle("42", "幫我建立一個 AI skill", "zh-1", "zh-TW"),
    );

    expect(response).toContain("還需要一項資料");
    expect(response).toContain("英文連字號名稱");
    expect(await repository.activeForOwner("42")).toMatchObject({
      ownerTelegramUserId: "42",
      status: "clarifying",
    });
  });

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
    expect(stale).toContain("stale or not applicable");
    const current = await repository.activeForOwner("42");
    const command = `/skill_approve ${current!.revisionNumber}`;
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

  it("treats a pull request for the exact approved commit as idempotent", async () => {
    const { locks, repository, service, git } = await fixture();
    await locks.withUser("42", () =>
      service.handle(
        "42",
        "Create a skill\nName: reports\nTasks: report\nMUST DO: cite\nMUST NOT DO: invent\nBETTER TO DO: summarize\nTools: shell",
        "30",
      ),
    );
    const draft = await repository.activeForOwner("42");
    git.listPullRequests.mockResolvedValueOnce([
      {
        number: 99,
        html_url: "https://example.test/pull/99",
        head: { sha: draft!.latestCommitSha },
        merged: true,
      },
    ]);
    const response = await locks.withUser("42", () =>
      service.handle("42", `/skill_approve ${draft!.revisionNumber}`, "31"),
    );
    expect(response).toContain("is merged into the configured base branch");
    expect(git.openPullRequest).not.toHaveBeenCalled();
  });

  it("requires a new revision when the approved branch moves", async () => {
    const { locks, repository, service, git } = await fixture();
    await locks.withUser("42", () =>
      service.handle(
        "42",
        "Create a skill\nName: reports\nTasks: report\nMUST DO: cite\nMUST NOT DO: invent\nBETTER TO DO: summarize\nTools: shell",
        "40",
      ),
    );
    const draft = await repository.activeForOwner("42");
    git.getBranchHead.mockResolvedValueOnce("f".repeat(40));
    const response = await locks.withUser("42", () =>
      service.handle("42", `/skill_approve ${draft!.revisionNumber}`, "41"),
    );
    expect(response).toContain("Revision required");
    expect(git.openPullRequest).not.toHaveBeenCalled();
    expect(await repository.activeForOwner("42")).toMatchObject({
      status: "revision_requested",
    });
  });
});
