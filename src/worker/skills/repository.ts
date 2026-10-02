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
import { isTelegramActorAllowed } from "../../shared/telegram-allowlist";
import { alignSkillMarkdown, markdownIdentity } from "./markdown";
import { skillManifestSchema, skillMarkdownSchema } from "./schemas";

type Projection = SkillDraft & { revision: number };

export interface SkillDraftGitClient {
  readonly controlledPrefix: string;
  readonly defaultBranch: string;
  getBranchHead(branch?: string): Promise<string>;
  createBranch(branch: string, baseCommitSha: string): Promise<string>;
  readFile(
    path: string,
    ref: string,
  ): Promise<{ sha: string; content: string; size?: number }>;
  compareCommits(
    base: string,
    head: string,
  ): Promise<{
    status: string;
    files: { path: string; status: string; size?: number }[];
  }>;
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
  listPullRequests(input: {
    state: "all";
    head: string;
    base: string;
  }): Promise<
    {
      number: number;
      html_url: string;
      head: { sha: string };
      merged?: boolean;
    }[]
  >;
}

export interface SkillAuthoringPolicy {
  /** Telegram identities provisioned by the operator, not supplied by a draft. */
  authorTelegramUserIds: ReadonlySet<string>;
  /** Public usernames, without "@" and compared case-insensitively. */
  authorTelegramUsernames?: ReadonlySet<string>;
  /** Capability IDs provisioned by the operator registry. */
  capabilityIds: ReadonlySet<string>;
  maxFileBytes?: number;
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
    private readonly policy: SkillAuthoringPolicy = {
      authorTelegramUserIds: new Set(),
      capabilityIds: new Set(),
    },
  ) {
    this.events = new EventStore(root);
  }

  async begin(draft: SkillDraft): Promise<SkillDraft> {
    if (!this.git) throw new Error("SKILL_GIT_REPOSITORY_REQUIRED");
    const base = await this.git.getBranchHead(this.git.defaultBranch);
    const branch = `ai/skill-${draft.stableId}-${draft.id}`;
    await this.git.createBranch(branch, base);
    return { ...draft, branch, baseCommitSha: base, latestCommitSha: base };
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
    const document = alignSkillMarkdown(
      content,
      draft.skillName,
      draft.intendedTasksDomain?.trim() || "Custom skill",
    );
    const contentDigest = skillDraftDigest(document);
    const identity = markdownIdentity(document);
    if (identity.name !== draft.skillName)
      throw new Error("SKILL_MARKDOWN_MANIFEST_MISMATCH");
    const manifest = `${JSON.stringify({ schemaVersion: 1, id: draft.stableId, name: draft.skillName, description: identity.description, revision, visibility: "private", ownerTelegramUserIds: [draft.ownerTelegramUserId], allowedTelegramUserIds: [], triggers: { phrases: [], keywords: [], minimumConfidence: 1 }, tools: draft.requiredToolsFunctions, prohibitedActions: draft.mustNotDo, status: "active", authoring: { draftId: draft.id, approvedRevision: revision, contentDigest, ownerTelegramUserId: draft.ownerTelegramUserId, requestedCapabilities: draft.requiredToolsFunctions } }, null, 2)}\n`;
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
      content: document,
      message,
      expectedSha: draft.skillBlobSha,
    });
    return {
      ...draft,
      draftContent: document,
      revisionNumber: revision,
      manifestBlobSha: manifestWrite.sha,
      skillBlobSha: skillWrite.sha,
      latestCommitSha: skillWrite.commitSha,
      contentDigest,
    };
  }

  async publish(
    draft: SkillDraft,
    username?: string,
  ): Promise<{ number: number; url: string; state: "created" | "merged" }> {
    if (!this.git || !draft.skillName || !draft.contentDigest)
      throw new Error("SKILL_DRAFT_INCOMPLETE");
    if (
      !isTelegramActorAllowed(
        {
          ids: this.policy.authorTelegramUserIds,
          ...(this.policy.authorTelegramUsernames
            ? { usernames: this.policy.authorTelegramUsernames }
            : {}),
        },
        draft.ownerTelegramUserId,
        username,
      )
    )
      throw new Error("SKILL_AUTHOR_NOT_AUTHORIZED");
    if (
      draft.requiredToolsFunctions.some(
        (capability) => !this.policy.capabilityIds.has(capability),
      )
    )
      throw new Error("SKILL_CAPABILITY_NOT_REGISTERED");

    try {
      const head = await this.git.getBranchHead(draft.branch);
      if (head !== draft.latestCommitSha)
        throw new Error("SKILL_REVISION_REQUIRED");
      const directory = `${this.git.controlledPrefix}/${draft.skillName}`;
      const comparison = await this.git.compareCommits(
        draft.baseCommitSha,
        head,
      );
      if (!["ahead", "identical"].includes(comparison.status))
        throw new Error("SKILL_REVISION_REQUIRED");
      const allowedPaths = new Set([
        `${directory}/manifest.json`,
        `${directory}/SKILL.md`,
      ]);
      const maximum = this.policy.maxFileBytes ?? 1_000_000;
      if (
        comparison.files.some(
          (file) =>
            !allowedPaths.has(file.path) ||
            file.status === "removed" ||
            (file.size !== undefined && file.size > maximum),
        )
      )
        throw new Error("SKILL_REVISION_REQUIRED");

      const [skillFile, manifestFile] = await Promise.all([
        this.git.readFile(`${directory}/SKILL.md`, head),
        this.git.readFile(`${directory}/manifest.json`, head),
      ]);
      if (
        skillFile.sha !== draft.skillBlobSha ||
        manifestFile.sha !== draft.manifestBlobSha ||
        Buffer.byteLength(skillFile.content, "utf8") > maximum ||
        Buffer.byteLength(manifestFile.content, "utf8") > maximum
      )
        throw new Error("SKILL_REVISION_REQUIRED");
      const content = skillMarkdownSchema.parse(skillFile.content);
      const manifest = skillManifestSchema.parse(
        JSON.parse(manifestFile.content),
      );
      const identity = markdownIdentity(content);
      const metadata = manifest.authoring;
      if (
        identity.name !== manifest.name ||
        (manifest.description ?? "") !== identity.description ||
        manifest.id !== draft.stableId ||
        manifest.revision !== draft.revisionNumber ||
        manifest.ownerTelegramUserIds.length !== 1 ||
        manifest.ownerTelegramUserIds[0] !== draft.ownerTelegramUserId ||
        manifest.tools.some((id) => !this.policy.capabilityIds.has(id)) ||
        !metadata ||
        metadata.draftId !== draft.id ||
        metadata.approvedRevision !== draft.revisionNumber ||
        metadata.contentDigest !== draft.contentDigest ||
        metadata.ownerTelegramUserId !== draft.ownerTelegramUserId ||
        JSON.stringify(metadata.requestedCapabilities) !==
          JSON.stringify(draft.requiredToolsFunctions) ||
        skillDraftDigest(content) !== draft.contentDigest
      )
        throw new Error("SKILL_REVISION_REQUIRED");

      const existing = (
        await this.git.listPullRequests({
          state: "all",
          head: draft.branch,
          base: this.git.defaultBranch,
        })
      ).find((pull) => pull.head.sha === head);
      if (existing)
        return {
          number: existing.number,
          url: existing.html_url,
          state: existing.merged ? "merged" : "created",
        };
      try {
        const pull = await this.git.openPullRequest({
          title: `Publish skill ${draft.skillName}`,
          head: draft.branch,
          base: this.git.defaultBranch,
        });
        return { number: pull.number, url: pull.html_url, state: "created" };
      } catch (error) {
        // A concurrent/retried request may have won the create race. Resolve
        // only by immutable head SHA; PR title/body are not authorization data.
        if ((error as { kind?: string }).kind !== "conflict") throw error;
        const raced = (
          await this.git.listPullRequests({
            state: "all",
            head: draft.branch,
            base: this.git.defaultBranch,
          })
        ).find((pull) => pull.head.sha === head);
        if (!raced) throw error;
        return {
          number: raced.number,
          url: raced.html_url,
          state: raced.merged ? "merged" : "created",
        };
      }
    } catch (error) {
      if (
        (error as Error).message === "SKILL_REVISION_REQUIRED" ||
        (error as { kind?: string }).kind === "conflict"
      )
        throw new Error("SKILL_REVISION_REQUIRED");
      throw error;
    }
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
