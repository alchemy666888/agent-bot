import { createHash } from "node:crypto";
import type { SkillDraft } from "../../worker/skills/types";
import {
  skillManifestSchema,
  skillMarkdownSchema,
} from "../../worker/skills/schemas";
import type { Pool } from "pg";

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
  /** Capability IDs provisioned by the operator registry. */
  capabilityIds: ReadonlySet<string>;
  maxFileBytes?: number;
}

export function skillDraftDigest(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

function markdownIdentity(content: string): {
  name: string;
  description: string;
} {
  const block = content.match(/^---\s*\n([\s\S]*?)^---\s*$/m)?.[1];
  const name = block?.match(/^name:\s*([^\n]+)\s*$/m)?.[1]?.trim();
  const description = block
    ?.match(/^description:\s*([^\n]+)\s*$/m)?.[1]
    ?.trim();
  if (!name || !description)
    throw new Error("SKILL_MARKDOWN_MANIFEST_MISMATCH");
  return { name, description };
}

export class PostgresSkillAuthoringRepository {
  private initialized?: Promise<void>;

  constructor(
    private readonly pool: Pool,
    private readonly git?: SkillDraftGitClient,
    private readonly policy: SkillAuthoringPolicy = {
      authorTelegramUserIds: new Set(),
      capabilityIds: new Set(),
    },
  ) {}

  async begin(draft: SkillDraft): Promise<SkillDraft> {
    if (!this.policy.authorTelegramUserIds.has(draft.ownerTelegramUserId))
      throw new Error("SKILL_AUTHOR_NOT_AUTHORIZED");
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
    const contentDigest = skillDraftDigest(content);
    const identity = markdownIdentity(content);
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
      contentDigest,
    };
  }

  async publish(
    draft: SkillDraft,
  ): Promise<{ number: number; url: string; state: "created" | "merged" }> {
    if (!this.git || !draft.skillName || !draft.contentDigest)
      throw new Error("SKILL_DRAFT_INCOMPLETE");
    if (!this.policy.authorTelegramUserIds.has(draft.ownerTelegramUserId))
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

  private initialize(): Promise<void> {
    return (this.initialized ??= this.pool
      .query(
        `CREATE TABLE IF NOT EXISTS telegram_skill_drafts (id text PRIMARY KEY, owner_telegram_user_id text NOT NULL, state jsonb NOT NULL, revision integer NOT NULL, last_processed_update_id text, updated_at timestamptz NOT NULL, UNIQUE(owner_telegram_user_id, last_processed_update_id))`,
      )
      .then(() => undefined));
  }

  private async rows(ownerTelegramUserId: string): Promise<Projection[]> {
    await this.initialize();
    const result = await this.pool.query<{
      state: SkillDraft;
      revision: number;
    }>(
      `SELECT state, revision FROM telegram_skill_drafts WHERE owner_telegram_user_id = $1 ORDER BY updated_at DESC`,
      [ownerTelegramUserId],
    );
    return result.rows.map((row) => ({ ...row.state, revision: row.revision }));
  }

  async activeForOwner(
    ownerTelegramUserId: string,
  ): Promise<Projection | undefined> {
    return (await this.rows(ownerTelegramUserId)).find(
      (draft) => !["installed", "cancelled"].includes(draft.status),
    );
  }

  async processedUpdate(
    ownerTelegramUserId: string,
    updateId: string,
  ): Promise<Projection | undefined> {
    return (await this.rows(ownerTelegramUserId)).find(
      (draft) => draft.lastProcessedUpdateId === updateId,
    );
  }

  async get(id: string): Promise<Projection | undefined> {
    await this.initialize();
    const result = await this.pool.query<{
      state: SkillDraft;
      revision: number;
    }>(`SELECT state, revision FROM telegram_skill_drafts WHERE id = $1`, [id]);
    const row = result.rows[0];
    return row ? { ...row.state, revision: row.revision } : undefined;
  }

  async save(draft: SkillDraft, eventType: string): Promise<Projection> {
    await this.initialize();
    const payload = { ...draft, draftContent: null };
    const result = await this.pool.query<{ revision: number }>(
      `INSERT INTO telegram_skill_drafts (id, owner_telegram_user_id, state, revision, last_processed_update_id, updated_at) VALUES ($1,$2,$3,1,$4,$5) ON CONFLICT (id) DO UPDATE SET state=EXCLUDED.state, revision=telegram_skill_drafts.revision+1, last_processed_update_id=EXCLUDED.last_processed_update_id, updated_at=EXCLUDED.updated_at RETURNING revision`,
      [
        draft.id,
        draft.ownerTelegramUserId,
        payload,
        draft.lastProcessedUpdateId,
        draft.updatedAt,
      ],
    );
    // Event persistence is append-only and lives beside the operational projection.
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS telegram_skill_draft_events (event_id bigserial PRIMARY KEY, draft_id text NOT NULL, owner_telegram_user_id text NOT NULL, event_type text NOT NULL, state jsonb NOT NULL, occurred_at timestamptz NOT NULL)`,
    );
    await this.pool.query(
      `INSERT INTO telegram_skill_draft_events (draft_id, owner_telegram_user_id, event_type, state, occurred_at) VALUES ($1,$2,$3,$4,$5)`,
      [
        draft.id,
        draft.ownerTelegramUserId,
        eventType,
        payload,
        draft.updatedAt,
      ],
    );
    return { ...payload, revision: result.rows[0]!.revision };
  }
}
