import { randomUUID } from "node:crypto";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { postgresPoolConfig } from "../../shared/postgres/client";
import {
  approvedSkillDraftSchema,
  installedSkillSchema,
  normalizeSkillName,
  type ApprovedSkillDraft,
  type InstalledSkill,
} from "./schemas";

type Queryable = {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
};

type TransactionPool = Queryable & { connect(): Promise<PoolClient> };

const MIGRATION = `
CREATE TABLE IF NOT EXISTS skills (
  id uuid PRIMARY KEY,
  normalized_name text NOT NULL UNIQUE,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS skill_versions (
  id uuid PRIMARY KEY,
  skill_id uuid NOT NULL REFERENCES skills(id),
  draft_id uuid NOT NULL,
  draft_revision integer NOT NULL CHECK (draft_revision > 0),
  version_number integer NOT NULL CHECK (version_number > 0),
  status text NOT NULL CHECK (status IN ('active','retired','superseded')),
  description text,
  approved_body text NOT NULL,
  approved_document jsonb NOT NULL,
  approved_by text NOT NULL,
  approved_at timestamptz NOT NULL,
  approval_source text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (draft_id, draft_revision),
  UNIQUE (skill_id, version_number)
);
CREATE UNIQUE INDEX IF NOT EXISTS skill_versions_one_active
  ON skill_versions(skill_id) WHERE status = 'active';
CREATE TABLE IF NOT EXISTS skill_owners (
  version_id uuid NOT NULL REFERENCES skill_versions(id) ON DELETE CASCADE,
  telegram_user_id text NOT NULL CHECK (telegram_user_id ~ '^[0-9]+$'),
  PRIMARY KEY (version_id, telegram_user_id)
);
CREATE TABLE IF NOT EXISTS skill_triggers (
  version_id uuid NOT NULL REFERENCES skill_versions(id) ON DELETE CASCADE,
  trigger_type text NOT NULL,
  trigger_value text NOT NULL,
  PRIMARY KEY (version_id, trigger_type, trigger_value)
);
CREATE TABLE IF NOT EXISTS skill_tools (
  version_id uuid NOT NULL REFERENCES skill_versions(id) ON DELETE CASCADE,
  tool_name text NOT NULL,
  PRIMARY KEY (version_id, tool_name)
);
CREATE TABLE IF NOT EXISTS skill_capabilities (
  version_id uuid NOT NULL REFERENCES skill_versions(id) ON DELETE CASCADE,
  capability text NOT NULL,
  PRIMARY KEY (version_id, capability)
);
CREATE TABLE IF NOT EXISTS skill_installation_failures (
  id bigserial PRIMARY KEY,
  draft_id uuid NOT NULL,
  draft_revision integer NOT NULL,
  retryable boolean NOT NULL DEFAULT true,
  error_code text NOT NULL,
  failed_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION protect_approved_skill_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.approved_body IS DISTINCT FROM OLD.approved_body
     OR NEW.approved_document IS DISTINCT FROM OLD.approved_document
     OR NEW.draft_id IS DISTINCT FROM OLD.draft_id
     OR NEW.draft_revision IS DISTINCT FROM OLD.draft_revision
     OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
     OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
     OR NEW.approval_source IS DISTINCT FROM OLD.approval_source THEN
    RAISE EXCEPTION 'approved skill versions are immutable';
  END IF;
  RETURN NEW;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'skill_versions_immutable_approval'
    AND tgrelid = 'skill_versions'::regclass) THEN
    CREATE TRIGGER skill_versions_immutable_approval
      BEFORE UPDATE ON skill_versions FOR EACH ROW
      EXECUTE FUNCTION protect_approved_skill_version();
  END IF;
END $$;`;

type VersionRow = {
  version_id: string;
  stable_id: string;
  draft_id: string;
  draft_revision: number;
  status: "active" | "retired" | "superseded";
  approved_document: unknown;
  created_at: Date | string;
  updated_at: Date | string;
};

export class PostgresSkillRepository {
  private initialized?: Promise<void>;

  constructor(private readonly pool: TransactionPool) {}

  initialize(): Promise<void> {
    return (this.initialized ??= this.pool
      .query(MIGRATION)
      .then(() => undefined));
  }

  async installApprovedDraft(
    input: ApprovedSkillDraft,
  ): Promise<InstalledSkill> {
    const draft = approvedSkillDraftSchema.parse(input);
    await this.initialize();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Serialize the idempotency key and logical skill, including concurrent first installs.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        draft.draftId,
      ]);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        draft.stableId,
      ]);
      const duplicate = await this.findByDraft(
        client,
        draft.draftId,
        draft.revision,
      );
      if (duplicate) {
        await client.query("COMMIT");
        return duplicate;
      }
      const normalizedName = normalizeSkillName(draft.name);
      const skill = await client.query<{ id: string }>(
        `INSERT INTO skills (id, normalized_name, display_name) VALUES ($1,$2,$3)
         ON CONFLICT (id) DO UPDATE SET display_name=EXCLUDED.display_name,
           normalized_name=EXCLUDED.normalized_name, updated_at=now()
         RETURNING id`,
        [draft.stableId, normalizedName, draft.name],
      );
      if (!skill.rows[0]) throw new Error("SKILL_IDENTITY_WRITE_FAILED");
      await client.query(
        "UPDATE skill_versions SET status='superseded', updated_at=now() WHERE skill_id=$1 AND status='active'",
        [draft.stableId],
      );
      const versionNumber = await client.query<{ next: number }>(
        "SELECT COALESCE(MAX(version_number),0)+1 AS next FROM skill_versions WHERE skill_id=$1",
        [draft.stableId],
      );
      const versionId = randomUUID();
      await client.query(
        `INSERT INTO skill_versions
         (id, skill_id, draft_id, draft_revision, version_number, status, description,
          approved_body, approved_document, approved_by, approved_at, approval_source)
         VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$8::jsonb,$9,$10,$11)`,
        [
          versionId,
          draft.stableId,
          draft.draftId,
          draft.revision,
          versionNumber.rows[0]?.next,
          draft.description ?? null,
          draft.body,
          JSON.stringify(draft),
          draft.approval.approvedBy,
          draft.approval.approvedAt,
          draft.approval.source ?? null,
        ],
      );
      await this.insertMetadata(client, versionId, draft);
      const installed = await this.findVersion(client, versionId);
      if (!installed) throw new Error("SKILL_INSTALL_READBACK_FAILED");
      await client.query("COMMIT");
      return installed;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      await this.recordFailure(draft.draftId, draft.revision, error);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Alias useful to callers that already establish approval in their service layer. */
  install(input: ApprovedSkillDraft): Promise<InstalledSkill> {
    return this.installApprovedDraft(input);
  }

  async getById(stableId: string): Promise<InstalledSkill | null> {
    await this.initialize();
    return this.findCurrent("s.id=$1", [stableId]);
  }

  async getByName(name: string): Promise<InstalledSkill | null> {
    await this.initialize();
    return this.findCurrent("s.normalized_name=$1", [normalizeSkillName(name)]);
  }

  async get(stableIdOrName: string): Promise<InstalledSkill | null> {
    const byId = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(stableIdOrName);
    return byId ? this.getById(stableIdOrName) : this.getByName(stableIdOrName);
  }

  async listInstalled(): Promise<InstalledSkill[]> {
    await this.initialize();
    return this.listQuery("v.status='active'", []);
  }

  async listAvailableToTelegramUser(
    telegramUserId: string,
  ): Promise<InstalledSkill[]> {
    if (!/^\d+$/.test(telegramUserId))
      throw new Error("INVALID_TELEGRAM_USER_ID");
    await this.initialize();
    return this.listQuery(
      "v.status='active' AND EXISTS (SELECT 1 FROM skill_owners o WHERE o.version_id=v.id AND o.telegram_user_id=$1)",
      [telegramUserId],
    );
  }

  async retireVersion(versionId: string): Promise<InstalledSkill | null> {
    return this.setStatus(versionId, "retired");
  }

  async supersedeVersion(versionId: string): Promise<InstalledSkill | null> {
    return this.setStatus(versionId, "superseded");
  }

  private async setStatus(versionId: string, status: "retired" | "superseded") {
    await this.initialize();
    await this.pool.query(
      "UPDATE skill_versions SET status=$2, updated_at=now() WHERE id=$1",
      [versionId, status],
    );
    return this.findVersion(this.pool, versionId);
  }

  private async insertMetadata(
    client: Queryable,
    versionId: string,
    draft: InstalledSkill | ReturnType<typeof approvedSkillDraftSchema.parse>,
  ) {
    for (const owner of new Set(draft.ownerTelegramUserIds))
      await client.query("INSERT INTO skill_owners VALUES ($1,$2)", [
        versionId,
        owner,
      ]);
    for (const trigger of draft.triggers)
      await client.query("INSERT INTO skill_triggers VALUES ($1,$2,$3)", [
        versionId,
        trigger.type,
        trigger.value,
      ]);
    for (const tool of new Set(draft.tools))
      await client.query("INSERT INTO skill_tools VALUES ($1,$2)", [
        versionId,
        tool,
      ]);
    for (const capability of new Set(draft.capabilities))
      await client.query("INSERT INTO skill_capabilities VALUES ($1,$2)", [
        versionId,
        capability,
      ]);
  }

  private async findCurrent(where: string, values: unknown[]) {
    const rows = await this.select(
      this.pool,
      `${where} AND v.status='active'`,
      values,
    );
    return rows[0] ? this.parseRow(rows[0]) : null;
  }

  private async listQuery(where: string, values: unknown[]) {
    const rows = await this.select(this.pool, where, values);
    return rows.map((row) => this.parseRow(row));
  }

  private async findVersion(db: Queryable, versionId: string) {
    const rows = await this.select(db, "v.id=$1", [versionId]);
    return rows[0] ? this.parseRow(rows[0]) : null;
  }

  private async findByDraft(db: Queryable, draftId: string, revision: number) {
    const rows = await this.select(
      db,
      "v.draft_id=$1 AND v.draft_revision=$2",
      [draftId, revision],
    );
    return rows[0] ? this.parseRow(rows[0]) : null;
  }

  private async select(db: Queryable, where: string, values: unknown[]) {
    return (
      await db.query<VersionRow>(
        `SELECT v.id version_id, s.id stable_id, v.draft_id, v.draft_revision,
        v.status, v.approved_document, v.created_at, v.updated_at
       FROM skill_versions v JOIN skills s ON s.id=v.skill_id
       WHERE ${where} ORDER BY s.normalized_name, v.created_at DESC`,
        values,
      )
    ).rows;
  }

  private parseRow(row: VersionRow): InstalledSkill {
    const document = approvedSkillDraftSchema.parse(row.approved_document);
    return installedSkillSchema.parse({
      ...document,
      stableId: row.stable_id,
      draftId: row.draft_id,
      revision: row.draft_revision,
      versionId: row.version_id,
      status: row.status,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    });
  }

  private async recordFailure(
    draftId: string,
    revision: number,
    error: unknown,
  ) {
    const errorCode =
      error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
        ? error.message
        : "SKILL_INSTALLATION_FAILED";
    await this.pool
      .query(
        "INSERT INTO skill_installation_failures (draft_id,draft_revision,retryable,error_code) VALUES ($1,$2,true,$3)",
        [draftId, revision, errorCode],
      )
      .catch(() => undefined);
  }
}

export function createPostgresSkillRepository(
  connectionString: string,
  certificateAuthority?: string,
) {
  return new PostgresSkillRepository(
    new Pool(postgresPoolConfig(connectionString, certificateAuthority)),
  );
}
