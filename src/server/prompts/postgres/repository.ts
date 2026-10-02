import "server-only";

import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { RefreshLease, SnapshotInput, StoredSnapshot } from "./types";

export class PromptTransitionConflict extends Error {
  constructor() {
    super("PROMPT_CHANGE_TRANSITION_CONFLICT");
  }
}

async function transaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await work(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function transition(
  pool: Pool,
  id: string,
  from: string,
  to: string,
  assignments: string,
  values: unknown[] = [],
) {
  const result = await pool.query(
    `UPDATE prompt_change_requests SET state = $3, ${assignments}
       WHERE id = $1 AND state = $2 RETURNING id`,
    [id, from, to, ...values],
  );
  if (result.rowCount !== 1) throw new PromptTransitionConflict();
}

export class PostgresPromptRepository {
  constructor(private readonly pool: Pool) {}

  confirmFirst(id: string, tokenDigest: string) {
    return this.pool
      .query(
        `UPDATE prompt_change_requests
            SET state = 'first_confirmed', first_confirmed_at = now()
          WHERE id = $1 AND state = 'proposed'
            AND confirmation_token_digest = $2 AND expires_at > now()
          RETURNING id`,
        [id, tokenDigest],
      )
      .then((result) => {
        if (result.rowCount !== 1) throw new PromptTransitionConflict();
      });
  }

  /** Consumes the second confirmation and claims the GitHub write atomically. */
  confirmSecondAndBeginCommit(id: string, tokenDigest: string): Promise<void> {
    return transaction(this.pool, async (client) => {
      const confirmed = await client.query(
        `UPDATE prompt_change_requests
            SET state = 'second_confirmed', second_confirmed_at = now()
          WHERE id = $1 AND state = 'first_confirmed'
            AND confirmation_token_digest = $2 AND expires_at > now()
          RETURNING id`,
        [id, tokenDigest],
      );
      if (confirmed.rowCount !== 1) throw new PromptTransitionConflict();
      await client.query(
        `UPDATE prompt_change_requests SET state = 'committing', committing_at = now()
          WHERE id = $1 AND state = 'second_confirmed'`,
        [id],
      );
    });
  }

  markVerified(id: string) {
    return transition(
      this.pool,
      id,
      "committing",
      "verified",
      "completed_at = now()",
    );
  }

  markFailed(id: string, failureCode: string) {
    return transition(
      this.pool,
      id,
      "committing",
      "failed",
      "completed_at = now(), failure_code = $4",
      [failureCode],
    );
  }

  cancel(id: string) {
    return this.pool
      .query(
        `UPDATE prompt_change_requests SET state = 'cancelled', completed_at = now()
        WHERE id = $1 AND state IN ('proposed','first_confirmed') RETURNING id`,
        [id],
      )
      .then((result) => {
        if (result.rowCount !== 1) throw new PromptTransitionConflict();
      });
  }

  expire(now = new Date()) {
    return this.pool
      .query(
        `UPDATE prompt_change_requests SET state = 'expired', completed_at = $1
        WHERE state IN ('proposed','first_confirmed') AND expires_at <= $1`,
        [now],
      )
      .then((result) => result.rowCount ?? 0);
  }

  acquireRefreshLease(lease: RefreshLease): Promise<boolean> {
    const lifetime = lease.expiresAt.getTime() - Date.now();
    if (lifetime <= 0 || lifetime > 5 * 60_000)
      throw new RangeError(
        "Refresh lease lifetime must be between 1ms and 5 minutes",
      );
    return this.pool
      .query(
        `INSERT INTO prompt_cache_entries
         (repository_owner, repository_name, repository_prefix, symbolic_ref, lease_owner, lease_expires_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (repository_owner, repository_name, repository_prefix, symbolic_ref)
       DO UPDATE SET lease_owner = EXCLUDED.lease_owner, lease_expires_at = EXCLUDED.lease_expires_at
         WHERE prompt_cache_entries.lease_expires_at IS NULL
            OR prompt_cache_entries.lease_expires_at <= now()
            OR prompt_cache_entries.lease_owner = EXCLUDED.lease_owner
       RETURNING lease_owner`,
        [
          lease.owner,
          lease.name,
          lease.prefix,
          lease.symbolicRef,
          lease.ownerId,
          lease.expiresAt,
        ],
      )
      .then((result) => result.rowCount === 1);
  }

  getActiveSnapshot(
    owner: string,
    name: string,
    prefix: string,
  ): Promise<StoredSnapshot | null> {
    return this.pool
      .query<
        {
          id: string;
          commit_sha: string;
          snapshot_payload: unknown;
          content_digest: string;
          validated_at: Date;
        } & QueryResultRow
      >(
        `SELECT id, commit_sha, snapshot_payload, content_digest, validated_at
           FROM prompt_snapshots
          WHERE repository_owner=$1 AND repository_name=$2 AND repository_prefix=$3
            AND active AND verified
          LIMIT 1`,
        [owner, name, prefix],
      )
      .then((result) => {
        const row = result.rows[0];
        return row
          ? {
              id: row.id,
              owner,
              name,
              prefix,
              commitSha: row.commit_sha,
              payload: row.snapshot_payload,
              contentDigest: row.content_digest,
              validatedAt: row.validated_at,
            }
          : null;
      });
  }

  async finishRefresh(
    lease: RefreshLease,
    commitSha: string,
    freshnessDeadline: Date,
  ): Promise<void> {
    const result = await this.pool.query(
      `UPDATE prompt_cache_entries
          SET current_verified_commit=$6, refreshed_at=now(), freshness_deadline=$7,
              error_at=NULL, error_code=NULL, lease_owner=NULL, lease_expires_at=NULL
        WHERE repository_owner=$1 AND repository_name=$2 AND repository_prefix=$3
          AND symbolic_ref=$4 AND lease_owner=$5`,
      [
        lease.owner,
        lease.name,
        lease.prefix,
        lease.symbolicRef,
        lease.ownerId,
        commitSha,
        freshnessDeadline,
      ],
    );
    if (result.rowCount !== 1) throw new Error("PROMPT_REFRESH_LEASE_LOST");
  }

  async failRefresh(lease: RefreshLease, errorCode: string): Promise<void> {
    await this.pool.query(
      `UPDATE prompt_cache_entries
          SET error_at=now(), error_code=$6, lease_owner=NULL, lease_expires_at=NULL
        WHERE repository_owner=$1 AND repository_name=$2 AND repository_prefix=$3
          AND symbolic_ref=$4 AND lease_owner=$5`,
      [
        lease.owner,
        lease.name,
        lease.prefix,
        lease.symbolicRef,
        lease.ownerId,
        errorCode,
      ],
    );
  }

  activateSnapshot(snapshot: SnapshotInput): Promise<void> {
    return transaction(this.pool, async (client) => {
      const inserted = await client.query<{ id: string } & QueryResultRow>(
        `INSERT INTO prompt_snapshots
          (repository_owner, repository_name, repository_prefix, commit_sha, snapshot_payload,
           content_digest, validated_at, verified)
         VALUES ($1,$2,$3,$4,$5,$6,$7,true)
         ON CONFLICT (repository_owner, repository_name, repository_prefix, commit_sha)
         DO UPDATE SET snapshot_payload=EXCLUDED.snapshot_payload,
           content_digest=EXCLUDED.content_digest, validated_at=EXCLUDED.validated_at, verified=true
         RETURNING id`,
        [
          snapshot.owner,
          snapshot.name,
          snapshot.prefix,
          snapshot.commitSha,
          snapshot.payload,
          snapshot.contentDigest,
          snapshot.validatedAt,
        ],
      );
      await client.query(
        `UPDATE prompt_snapshots SET active = false
          WHERE repository_owner=$1 AND repository_name=$2 AND repository_prefix=$3 AND active`,
        [snapshot.owner, snapshot.name, snapshot.prefix],
      );
      await client.query(
        "UPDATE prompt_snapshots SET active = true WHERE id = $1",
        [inserted.rows[0].id],
      );
    });
  }

  /** Publishes a read-back-verified snapshot and completes its request atomically. */
  activateSnapshotAndMarkVerified(
    changeRequestId: string,
    snapshot: SnapshotInput,
  ): Promise<void> {
    return transaction(this.pool, async (client) => {
      const inserted = await client.query<{ id: string } & QueryResultRow>(
        `INSERT INTO prompt_snapshots
          (repository_owner, repository_name, repository_prefix, commit_sha, snapshot_payload,
           content_digest, validated_at, verified)
         VALUES ($1,$2,$3,$4,$5,$6,$7,true)
         ON CONFLICT (repository_owner, repository_name, repository_prefix, commit_sha)
         DO UPDATE SET snapshot_payload=EXCLUDED.snapshot_payload,
           content_digest=EXCLUDED.content_digest, validated_at=EXCLUDED.validated_at, verified=true
         RETURNING id`,
        [
          snapshot.owner,
          snapshot.name,
          snapshot.prefix,
          snapshot.commitSha,
          snapshot.payload,
          snapshot.contentDigest,
          snapshot.validatedAt,
        ],
      );
      await client.query(
        `UPDATE prompt_snapshots SET active = false
          WHERE repository_owner=$1 AND repository_name=$2 AND repository_prefix=$3 AND active`,
        [snapshot.owner, snapshot.name, snapshot.prefix],
      );
      await client.query(
        "UPDATE prompt_snapshots SET active = true WHERE id = $1",
        [inserted.rows[0].id],
      );
      const completed = await client.query(
        `UPDATE prompt_change_requests SET state='verified', completed_at=now()
          WHERE id=$1 AND state='committing' RETURNING id`,
        [changeRequestId],
      );
      if (completed.rowCount !== 1) throw new PromptTransitionConflict();
    });
  }
}
