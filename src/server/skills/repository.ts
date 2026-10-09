import type { Pool } from "pg";
import { isTelegramActorAllowed } from "../../shared/telegram-allowlist";
import {
  prepareSkillRevision,
  skillDraftDigest,
} from "../../worker/skills/authoring-document";
import {
  SkillRevisionConflictError,
  type SkillDefinitionStore,
} from "../../worker/skills/definition-store";
import type { SkillDraft } from "../../worker/skills/types";

export { skillDraftDigest };

type Projection = SkillDraft & { revision: number };

export interface SkillAuthoringPolicy {
  /** Telegram identities provisioned by the operator, not supplied by a draft. */
  authorTelegramUserIds: ReadonlySet<string>;
  /** Public usernames, without "@" and compared case-insensitively. */
  authorTelegramUsernames?: ReadonlySet<string>;
  /** Telegram identities allowed to publish a pending revision. */
  approverTelegramUserIds?: ReadonlySet<string>;
  /** Capability IDs provisioned by the operator registry. */
  capabilityIds: ReadonlySet<string>;
}

function authorAllowed(
  policy: SkillAuthoringPolicy,
  userId: string,
  username?: string,
): boolean {
  return isTelegramActorAllowed(
    {
      ids: policy.authorTelegramUserIds,
      ...(policy.authorTelegramUsernames
        ? { usernames: policy.authorTelegramUsernames }
        : {}),
    },
    userId,
    username,
  );
}

export class PostgresSkillAuthoringRepository {
  private initialized?: Promise<void>;

  constructor(
    private readonly pool: Pool,
    private readonly definitions: SkillDefinitionStore,
    private readonly policy: SkillAuthoringPolicy = {
      authorTelegramUserIds: new Set(),
      capabilityIds: new Set(),
    },
  ) {}

  async begin(draft: SkillDraft, username?: string): Promise<SkillDraft> {
    if (!authorAllowed(this.policy, draft.ownerTelegramUserId, username))
      throw new Error("SKILL_AUTHOR_NOT_AUTHORIZED");
    return { ...draft, versionId: null, contentDigest: null };
  }

  async commitRevision(
    draft: SkillDraft,
    content: string,
  ): Promise<SkillDraft> {
    const prepared = prepareSkillRevision(draft, content);
    try {
      const version = await this.definitions.insertDraftVersion({
        skillId: draft.stableId,
        name: prepared.manifest.name,
        ownerTelegramUserId: draft.ownerTelegramUserId,
        visibility: prepared.manifest.visibility,
        expectedRevision: draft.revisionNumber,
        contentDigest: prepared.contentDigest,
        manifest: prepared.manifest,
        instructions: prepared.document,
        createdBy: draft.ownerTelegramUserId,
      });
      return {
        ...draft,
        draftContent: prepared.document,
        revisionNumber: version.revision,
        versionId: version.id,
        contentDigest: prepared.contentDigest,
      };
    } catch (error) {
      if (error instanceof SkillRevisionConflictError)
        throw new Error("SKILL_REVISION_REQUIRED");
      throw error;
    }
  }

  async publish(
    draft: SkillDraft,
    username?: string,
  ): Promise<{ state: "pending"; versionId: string; revision: number }> {
    if (!draft.skillName || !draft.contentDigest || !draft.versionId)
      throw new Error("SKILL_DRAFT_INCOMPLETE");
    if (!authorAllowed(this.policy, draft.ownerTelegramUserId, username))
      throw new Error("SKILL_AUTHOR_NOT_AUTHORIZED");
    if (
      draft.requiredToolsFunctions.some(
        (capability) => !this.policy.capabilityIds.has(capability),
      )
    )
      throw new Error("SKILL_CAPABILITY_NOT_REGISTERED");
    try {
      const pending = await this.definitions.markPending({
        skillId: draft.stableId,
        versionId: draft.versionId,
        expectedRevision: draft.revisionNumber,
        contentDigest: draft.contentDigest,
        actor: draft.ownerTelegramUserId,
      });
      return {
        state: "pending",
        versionId: pending.id,
        revision: pending.revision,
      };
    } catch (error) {
      if (error instanceof SkillRevisionConflictError)
        throw new Error("SKILL_REVISION_REQUIRED");
      throw error;
    }
  }

  async publishApproved(input: {
    actorTelegramUserId: string;
    skillId: string;
    revision: number;
  }): Promise<{ name: string; revision: number; versionId: string }> {
    if (!this.policy.approverTelegramUserIds?.has(input.actorTelegramUserId))
      throw new Error("SKILL_APPROVER_NOT_AUTHORIZED");
    const version = await this.definitions.getRevision(
      input.skillId,
      input.revision,
    );
    if (!version) throw new Error("SKILL_REVISION_REQUIRED");
    if (version.manifest.tools.some((id) => !this.policy.capabilityIds.has(id)))
      throw new Error("SKILL_CAPABILITY_NOT_REGISTERED");
    try {
      const published = await this.definitions.publish({
        skillId: input.skillId,
        expectedRevision: input.revision,
        actor: input.actorTelegramUserId,
      });
      return {
        name: published.manifest.name,
        revision: published.revision,
        versionId: published.id,
      };
    } catch (error) {
      if (error instanceof SkillRevisionConflictError)
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
