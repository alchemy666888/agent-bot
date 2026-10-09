import "server-only";

import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  SkillRevisionConflictError,
  type InsertDraftVersionInput,
  type SkillDefinitionStore,
  type SkillRecord,
  type SkillVersionRecord,
  type SkillVersionState,
} from "../../worker/skills/definition-store";
import { skillManifestSchema } from "../../worker/skills/schemas";

interface VersionRow {
  id: string;
  skill_id: string;
  revision: number;
  content_digest: string;
  manifest: unknown;
  instructions: string;
  state: SkillVersionState;
  created_by: string;
}

function versionFrom(row: VersionRow): SkillVersionRecord {
  return {
    id: row.id,
    skillId: row.skill_id,
    revision: Number(row.revision),
    contentDigest: row.content_digest,
    manifest: skillManifestSchema.parse(row.manifest),
    instructions: row.instructions,
    state: row.state,
    createdBy: row.created_by,
  };
}

export class PostgresSkillDefinitionStore implements SkillDefinitionStore {
  constructor(private readonly pool: Pool) {}

  private async transaction<T>(
    action: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await action(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505")
        throw new SkillRevisionConflictError();
      throw error;
    } finally {
      client.release();
    }
  }

  private async audit(
    client: PoolClient,
    eventKind: string,
    actor: string,
    skillId: string,
    versionId: string,
  ) {
    await client.query(
      `INSERT INTO skill_audit_events (event_kind, actor_telegram_user_id, skill_id, version_id)
       VALUES ($1, $2, $3, $4)`,
      [eventKind, actor, skillId, versionId],
    );
  }

  private async lockRevision(
    client: PoolClient,
    skillId: string,
  ): Promise<number> {
    const skill = await client.query(
      `SELECT id FROM skills WHERE id = $1 FOR UPDATE`,
      [skillId],
    );
    if (!skill.rows[0]) throw new SkillRevisionConflictError();
    const latest = await client.query<{ revision: number }>(
      `SELECT COALESCE(MAX(revision), 0)::int AS revision
         FROM skill_versions WHERE skill_id = $1`,
      [skillId],
    );
    return Number(latest.rows[0]?.revision ?? 0);
  }

  async insertDraftVersion(
    input: InsertDraftVersionInput,
  ): Promise<SkillVersionRecord> {
    return this.transaction(async (client) => {
      await client.query(
        `INSERT INTO skills (id, name, owner_telegram_user_id, visibility, status)
         VALUES ($1, $2, $3, $4, 'active')
         ON CONFLICT (id) DO NOTHING`,
        [
          input.skillId,
          input.name,
          input.ownerTelegramUserId,
          input.visibility,
        ],
      );
      const latest = await this.lockRevision(client, input.skillId);
      if (latest !== input.expectedRevision)
        throw new SkillRevisionConflictError();
      const id = input.versionId ?? randomUUID();
      const inserted = await client.query<VersionRow>(
        `INSERT INTO skill_versions
           (id, skill_id, revision, content_digest, manifest, instructions, state, created_by)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'draft', $7)
         RETURNING id, skill_id, revision, content_digest, manifest, instructions, state, created_by`,
        [
          id,
          input.skillId,
          input.expectedRevision + 1,
          input.contentDigest,
          JSON.stringify(input.manifest),
          input.instructions,
          input.createdBy,
        ],
      );
      const version = versionFrom(inserted.rows[0]!);
      await this.audit(
        client,
        "skill.draft_saved",
        input.createdBy,
        input.skillId,
        version.id,
      );
      return version;
    });
  }

  async markPending(input: {
    skillId: string;
    versionId: string;
    expectedRevision: number;
    contentDigest: string;
    actor: string;
  }): Promise<SkillVersionRecord> {
    return this.transaction(async (client) => {
      const latest = await this.lockRevision(client, input.skillId);
      if (latest !== input.expectedRevision)
        throw new SkillRevisionConflictError();
      const current = await client.query<VersionRow>(
        `SELECT id, skill_id, revision, content_digest, manifest, instructions, state, created_by
           FROM skill_versions WHERE skill_id = $1 AND id = $2`,
        [input.skillId, input.versionId],
      );
      const row = current.rows[0];
      if (
        !row ||
        Number(row.revision) !== input.expectedRevision ||
        row.content_digest !== input.contentDigest
      )
        throw new SkillRevisionConflictError();
      if (row.state === "pending") return versionFrom(row);
      const updated = await client.query<VersionRow>(
        `UPDATE skill_versions SET state = 'pending'
          WHERE id = $1 AND skill_id = $2 AND state = 'draft'
          RETURNING id, skill_id, revision, content_digest, manifest, instructions, state, created_by`,
        [input.versionId, input.skillId],
      );
      if (!updated.rows[0]) throw new SkillRevisionConflictError();
      const version = versionFrom(updated.rows[0]);
      await this.audit(
        client,
        "skill.pending",
        input.actor,
        input.skillId,
        version.id,
      );
      return version;
    });
  }

  async publish(input: {
    skillId: string;
    expectedRevision: number;
    actor: string;
  }): Promise<SkillVersionRecord> {
    return this.transaction(async (client) => {
      const latest = await this.lockRevision(client, input.skillId);
      if (latest !== input.expectedRevision)
        throw new SkillRevisionConflictError();
      const current = await client.query<VersionRow>(
        `SELECT id, skill_id, revision, content_digest, manifest, instructions, state, created_by
           FROM skill_versions WHERE skill_id = $1 AND revision = $2`,
        [input.skillId, input.expectedRevision],
      );
      const row = current.rows[0];
      if (!row) throw new SkillRevisionConflictError();
      if (row.state === "published") return versionFrom(row);
      const updated = await client.query<VersionRow>(
        `UPDATE skill_versions SET state = 'published'
          WHERE id = $1 AND state = 'pending'
          RETURNING id, skill_id, revision, content_digest, manifest, instructions, state, created_by`,
        [row.id],
      );
      if (!updated.rows[0]) throw new SkillRevisionConflictError();
      const version = versionFrom(updated.rows[0]);
      await client.query(
        `UPDATE skills
            SET current_version_id = $2,
                name = $3,
                visibility = $4,
                status = 'active',
                updated_at = now()
          WHERE id = $1`,
        [
          input.skillId,
          version.id,
          version.manifest.name,
          version.manifest.visibility,
        ],
      );
      await this.audit(
        client,
        "skill.published",
        input.actor,
        input.skillId,
        version.id,
      );
      return version;
    });
  }

  async retire(input: {
    skillId: string;
    expectedRevision: number;
    actor: string;
    versionId?: string;
    manifest: import("../../worker/skills/schemas").SkillManifest;
    instructions: string;
    contentDigest: string;
  }): Promise<SkillVersionRecord> {
    return this.transaction(async (client) => {
      const latest = await this.lockRevision(client, input.skillId);
      if (latest !== input.expectedRevision)
        throw new SkillRevisionConflictError();
      const id = input.versionId ?? randomUUID();
      const inserted = await client.query<VersionRow>(
        `INSERT INTO skill_versions
           (id, skill_id, revision, content_digest, manifest, instructions, state, created_by)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'retired', $7)
         RETURNING id, skill_id, revision, content_digest, manifest, instructions, state, created_by`,
        [
          id,
          input.skillId,
          input.expectedRevision + 1,
          input.contentDigest,
          JSON.stringify(input.manifest),
          input.instructions,
          input.actor,
        ],
      );
      const version = versionFrom(inserted.rows[0]!);
      await client.query(
        `UPDATE skills
            SET status = 'retired', current_version_id = $2, updated_at = now()
          WHERE id = $1`,
        [input.skillId, version.id],
      );
      await this.audit(
        client,
        "skill.retired",
        input.actor,
        input.skillId,
        version.id,
      );
      return version;
    });
  }

  async getRevision(
    skillId: string,
    revision: number,
  ): Promise<SkillVersionRecord | null> {
    const result = await this.pool.query<VersionRow>(
      `SELECT id, skill_id, revision, content_digest, manifest, instructions, state, created_by
         FROM skill_versions WHERE skill_id = $1 AND revision = $2`,
      [skillId, revision],
    );
    return result.rows[0] ? versionFrom(result.rows[0]) : null;
  }

  async getVersion(
    skillId: string,
    versionId: string,
  ): Promise<SkillVersionRecord | null> {
    const result = await this.pool.query<VersionRow>(
      `SELECT id, skill_id, revision, content_digest, manifest, instructions, state, created_by
         FROM skill_versions WHERE skill_id = $1 AND id = $2`,
      [skillId, versionId],
    );
    return result.rows[0] ? versionFrom(result.rows[0]) : null;
  }

  async getSkill(skillId: string): Promise<SkillRecord | null> {
    const result = await this.pool.query<{
      id: string;
      name: string;
      owner_telegram_user_id: string;
      visibility: SkillRecord["visibility"];
      status: SkillRecord["status"];
      current_version_id: string | null;
    }>(
      `SELECT id, name, owner_telegram_user_id, visibility, status, current_version_id
         FROM skills WHERE id = $1`,
      [skillId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      ownerTelegramUserId: row.owner_telegram_user_id,
      visibility: row.visibility,
      status: row.status,
      currentVersionId: row.current_version_id,
    };
  }

  async listCurrentPublished(): Promise<
    Array<{ skill: SkillRecord; version: SkillVersionRecord }>
  > {
    const result = await this.pool.query<
      VersionRow & {
        skill_name: string;
        owner_telegram_user_id: string;
        visibility: SkillRecord["visibility"];
        skill_status: SkillRecord["status"];
        current_version_id: string;
      }
    >(
      `SELECT s.name AS skill_name, s.owner_telegram_user_id, s.visibility,
              s.status AS skill_status, s.current_version_id,
              v.id, v.skill_id, v.revision, v.content_digest, v.manifest,
              v.instructions, v.state, v.created_by
         FROM skills s
         JOIN skill_versions v ON v.id = s.current_version_id
        WHERE s.status = 'active' AND v.state = 'published'`,
    );
    return result.rows.map((row) => ({
      skill: {
        id: row.skill_id,
        name: row.skill_name,
        ownerTelegramUserId: row.owner_telegram_user_id,
        visibility: row.visibility,
        status: row.skill_status,
        currentVersionId: row.current_version_id,
      },
      version: versionFrom(row),
    }));
  }
}
