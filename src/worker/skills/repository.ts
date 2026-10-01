import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { uuidV7 } from "../../shared/ids";
import { EventStore } from "../persistence/event-store";
import { statePath } from "../persistence/layout";
import { projectEvent } from "../persistence/projector";
import type { DurableEvent } from "../persistence/schemas";
import type { LockCoordinator } from "../locks/coordinator";
import type { SkillDraft } from "./types";

type Projection = SkillDraft & { revision: number };

export interface SkillDraftGitClient {
  readonly controlledPrefix: string;
  readonly defaultBranch: string;
  getBranchHead(branch?: string): Promise<string>;
  createBranch(branch: string, baseCommitSha: string): Promise<string>;
  readFile(
    path: string,
    ref: string,
  ): Promise<{ sha: string; content: string }>;
  putFile(input: {
    path: string;
    branch: string;
    content: string;
    message: string;
    expectedSha: string | null;
  }): Promise<{ sha: string; commitSha: string }>;
  openPullRequest(input: {
    title: string;
    body?: string;
    head: string;
    base?: string;
  }): Promise<{ number: number; html_url: string }>;
}

export function skillDraftDigest(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

export class DurableSkillDraftRepository {
  private readonly events: EventStore;

  constructor(
    private readonly root: string,
    private readonly locks: LockCoordinator,
    private readonly git?: SkillDraftGitClient,
  ) {
    this.events = new EventStore(root);
  }

  async begin(draft: SkillDraft): Promise<SkillDraft> {
    if (!this.git) throw new Error("SKILL_GIT_REPOSITORY_REQUIRED");
    const base = await this.git.getBranchHead(this.git.defaultBranch);
    const branch = `ai/skill-${draft.stableId}-${draft.id}`;
    await this.git.createBranch(branch, base);
    return { ...draft, branch, latestCommitSha: base };
  }

  async commitRevision(
    draft: SkillDraft,
    content: string,
  ): Promise<SkillDraft> {
    if (!this.git || !draft.skillName)
      throw new Error("SKILL_DRAFT_INCOMPLETE");
    // Re-read the branch head so an out-of-band change cannot be silently approved.
    const head = await this.git.getBranchHead(draft.branch);
    if (head !== draft.latestCommitSha)
      throw new Error("SKILL_DRAFT_BRANCH_CHANGED");
    const directory = `${this.git.controlledPrefix}/${draft.skillName}`;
    const revision = draft.revisionNumber + 1;
    const manifest = `${JSON.stringify({ schemaVersion: 1, id: draft.stableId, name: draft.skillName, revision, visibility: "private", ownerTelegramUserIds: [draft.ownerTelegramUserId], allowedTelegramUserIds: [], triggers: { phrases: [], keywords: [], minimumConfidence: 1 }, tools: draft.requiredToolsFunctions, prohibitedActions: draft.mustNotDo, status: "active" }, null, 2)}\n`;
    const message = `Draft ${draft.id} revision ${revision}`;
    const manifestWrite = await this.git.putFile({
      path: `${directory}/manifest.json`,
      branch: draft.branch,
      content: manifest,
      message,
      expectedSha: draft.manifestBlobSha,
    });
    const skillWrite = await this.git.putFile({
      path: `${directory}/SKILL.md`,
      branch: draft.branch,
      content,
      message,
      expectedSha: draft.skillBlobSha,
    });
    return {
      ...draft,
      draftContent: content,
      revisionNumber: revision,
      manifestBlobSha: manifestWrite.sha,
      skillBlobSha: skillWrite.sha,
      latestCommitSha: skillWrite.commitSha,
      contentDigest: skillDraftDigest(content),
    };
  }

  async publish(draft: SkillDraft): Promise<{ number: number; url: string }> {
    if (!this.git || !draft.skillName || !draft.contentDigest)
      throw new Error("SKILL_DRAFT_INCOMPLETE");
    const head = await this.git.getBranchHead(draft.branch);
    if (head !== draft.latestCommitSha) throw new Error("SKILL_APPROVAL_STALE");
    const file = await this.git.readFile(
      `${this.git.controlledPrefix}/${draft.skillName}/SKILL.md`,
      head,
    );
    if (
      file.sha !== draft.skillBlobSha ||
      skillDraftDigest(file.content) !== draft.contentDigest
    )
      throw new Error("SKILL_APPROVAL_STALE");
    const pull = await this.git.openPullRequest({
      title: `Publish skill ${draft.skillName}`,
      body: `Approved draft ${draft.id}, revision ${draft.revisionNumber}, commit ${head}, digest ${draft.contentDigest}.`,
      head: draft.branch,
      base: this.git.defaultBranch,
    });
    return { number: pull.number, url: pull.html_url };
  }

  async activeForOwner(
    ownerTelegramUserId: string,
  ): Promise<Projection | undefined> {
    return (await this.forOwner(ownerTelegramUserId)).find(
      (draft) => !["installed", "cancelled"].includes(draft.status),
    );
  }

  async processedUpdate(
    ownerTelegramUserId: string,
    updateId: string,
  ): Promise<Projection | undefined> {
    return (await this.forOwner(ownerTelegramUserId)).find(
      (draft) => draft.lastProcessedUpdateId === updateId,
    );
  }

  private async forOwner(ownerTelegramUserId: string): Promise<Projection[]> {
    const directory = dirname(statePath(this.root, "skill-drafts", "x"));
    const names = await readdir(directory).catch(() => [] as string[]);
    const drafts = await Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .map(
          async (name) =>
            JSON.parse(
              await readFile(join(directory, name), "utf8"),
            ) as Projection,
        ),
    );
    return drafts
      .filter((draft) => draft.ownerTelegramUserId === ownerTelegramUserId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string): Promise<Projection | undefined> {
    try {
      return JSON.parse(
        await readFile(statePath(this.root, "skill-drafts", id), "utf8"),
      ) as Projection;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async save(draft: SkillDraft, type: string): Promise<Projection> {
    const prior = await this.get(draft.id);
    // Only restart/co-ordination data is persisted under TELEGRAM_AGENT_ROOT.
    // Skill documents and installation metadata live exclusively in GitHub.
    const payload: Record<string, unknown> = { ...draft, draftContent: null };
    // Projection metadata is never aggregate data and must not overwrite the
    // new event's monotonically increasing revision/source identifiers.
    delete payload.schemaVersion;
    delete payload.entityId;
    delete payload.revision;
    delete payload.sourceEventId;
    const event: DurableEvent = {
      schemaVersion: 1,
      eventId: uuidV7(),
      entityId: draft.id,
      kind: "skill-drafts",
      type,
      occurredAt: draft.updatedAt,
      revision: (prior?.revision ?? 0) + 1,
      payload,
    };
    await this.locks.withMutation(async () => {
      await this.events.append(event);
      await projectEvent(this.root, event);
    }, draft.ownerTelegramUserId);
    return { ...(payload as unknown as SkillDraft), revision: event.revision };
  }
}
