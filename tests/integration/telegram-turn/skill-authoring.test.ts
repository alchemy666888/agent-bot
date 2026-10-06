import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LockCoordinator } from "../../../src/worker/locks/coordinator";
import { initializeLayout } from "../../../src/worker/persistence/layout";
import {
  DurableSkillDraftRepository,
  type SkillDraftGitClient,
} from "../../../src/worker/skills/repository";
import { SkillAuthoringService } from "../../../src/worker/skills/service";

const BASE_SHA = "0".repeat(40);
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

type StoredFile = { content: string; sha: string };

class GitHubAdapterFake implements SkillDraftGitClient {
  readonly controlledPrefix = "skills";
  readonly defaultBranch = "main";
  readonly branches = new Map([[this.defaultBranch, BASE_SHA]]);
  readonly files = new Map<string, StoredFile>();
  readonly pullRequests: Array<{
    number: number;
    html_url: string;
    head: { sha: string };
    branch: string;
  }> = [];
  authenticationFailure = false;
  private sequence = 1;

  private sha() {
    return (this.sequence++).toString(16).padStart(40, "0");
  }

  async getBranchHead(branch = this.defaultBranch) {
    if (this.authenticationFailure)
      throw new Error("GITHUB_AUTHENTICATION_FAILED");
    const head = this.branches.get(branch);
    if (!head) throw new Error("GITHUB_BRANCH_NOT_FOUND");
    return head;
  }

  async createBranch(branch: string, baseCommitSha: string) {
    if (this.authenticationFailure)
      throw new Error("GITHUB_AUTHENTICATION_FAILED");
    this.branches.set(branch, baseCommitSha);
    return baseCommitSha;
  }

  async putFile(input: {
    path: string;
    branch: string;
    content: string;
    message: string;
    expectedSha: string | null;
  }) {
    expect(this.files.get(input.path)?.sha ?? null).toBe(input.expectedSha);
    const sha = this.sha();
    const commitSha = this.sha();
    this.files.set(input.path, { content: input.content, sha });
    this.branches.set(input.branch, commitSha);
    return { sha, commitSha };
  }

  async readFile(path: string) {
    const file = this.files.get(path);
    if (!file) throw new Error("GITHUB_FILE_NOT_FOUND");
    return { ...file, size: Buffer.byteLength(file.content) };
  }

  async compareCommits() {
    return {
      status: "ahead",
      files: [...this.files.entries()].map(([path, file]) => ({
        path,
        status: "added",
        size: Buffer.byteLength(file.content),
      })),
    };
  }

  async openPullRequest(input: {
    title: string;
    body?: string;
    head: string;
    base?: string;
  }) {
    const pull = {
      number: 73,
      html_url: "https://github.test/acme/skills/pull/73",
      head: { sha: this.branches.get(input.head)! },
      branch: input.head,
    };
    this.pullRequests.push(pull);
    return pull;
  }

  async listPullRequests(input: { state: "all"; head: string; base: string }) {
    return this.pullRequests.filter((pull) => pull.branch === input.head);
  }
}

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
  git?: GitHubAdapterFake;
}) {
  root = await mkdtemp(join(tmpdir(), "telegram-skill-authoring-"));
  await initializeLayout(root);
  const locks = new LockCoordinator(root);
  const git = options?.git ?? new GitHubAdapterFake();
  const repository = new DurableSkillDraftRepository(root, locks, git, {
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
  return { git, locks, repository, generator, service };
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
  it("authors, durably revises, explicitly approves, and publishes the reviewed files", async () => {
    const { git, locks, repository, generator } = await fixture();

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
    expect(sentText()).toContain("pull request #73");
    expect(git.branches.get(reviewed!.branch)).toBe(reviewed!.latestCommitSha);
    expect(git.files.get("skills/release-auditor/SKILL.md")?.content).toContain(
      "Review note: Use a compact Markdown table for the findings",
    );
    expect(
      JSON.parse(
        git.files.get("skills/release-auditor/manifest.json")!.content,
      ),
    ).toMatchObject({
      name: "release-auditor",
      revision: 2,
      ownerTelegramUserIds: [AUTHOR],
      tools: ["shell"],
      authoring: { approvedRevision: 2, requestedCapabilities: ["shell"] },
    });
    expect(git.pullRequests).toEqual([
      expect.objectContaining({ number: 73, branch: reviewed!.branch }),
    ]);
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

  it("surfaces GitHub authentication failure without creating a durable draft", async () => {
    const git = new GitHubAdapterFake();
    git.authenticationFailure = true;
    const { repository } = await fixture({ git });
    await expect(dispatch("540", COMPLETE_REQUEST)).rejects.toThrow(
      "GITHUB_AUTHENTICATION_FAILED",
    );
    expect(await repository.activeForOwner(AUTHOR)).toBeUndefined();
  });

  it("requires another revision when the reviewed branch diverges", async () => {
    const { git, repository } = await fixture();
    await dispatch("550", COMPLETE_REQUEST);
    const draft = await repository.activeForOwner(AUTHOR);
    git.branches.set(draft!.branch, "f".repeat(40));
    await dispatch("551", "/skill_approve 1");
    expect(sentText()).toContain("Revision required");
    expect(git.pullRequests).toHaveLength(0);
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
    const { git, repository } = await fixture({ authors: [AUTHOR, "99"] });
    await dispatch("570", COMPLETE_REQUEST);
    await expect(dispatch("571", "/skill_approve 1", "99")).rejects.toThrow(
      "SKILL_DRAFT_NOT_ACTIVE",
    );
    expect(git.pullRequests).toHaveLength(0);
    expect(await repository.activeForOwner(AUTHOR)).toMatchObject({
      status: "awaiting_approval",
    });
  });
});
