import { randomBytes } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { uuidV7 } from "../ids";
import { postgresPoolConfig } from "../postgres/client";
import { readDatabaseConfig } from "../postgres/config";
import { MAX_SCHEDULES_PER_TICK, MAX_SCHEDULES_PER_USER } from "./spec";
import {
  scheduleMetadataSchema,
  type ScheduleMetadata,
  type ScheduledTask,
} from "./types";

type TaskRow = {
  id: string;
  public_id: string;
  owner_telegram_user_id: string;
  chat_id: string;
  username: string | null;
  language_code: string | null;
  source_message: string;
  user_prompt: string;
  metadata: unknown;
  status: "active" | "paused";
  next_run_at: Date | string;
  last_run_at: Date | string | null;
  failure_count: number;
};

let pool: Pool | undefined;

function databasePool(): Pool {
  if (!pool) {
    const database = readDatabaseConfig();
    pool = new Pool(
      postgresPoolConfig(database.DATABASE_URL, database.AIVEN_PG_CA),
    );
  }
  return pool;
}

const COLUMNS = `id, public_id, owner_telegram_user_id, chat_id, username,
  language_code, source_message, user_prompt, metadata, status, next_run_at,
  last_run_at, failure_count`;

export async function hasActiveSchedule(): Promise<boolean> {
  const result = await databasePool().query<{ active: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM scheduled_tasks WHERE status = 'active') AS active",
  );
  return result.rows[0]?.active === true;
}

export async function claimDueSchedules(
  now: Date,
  leaseOwner: string,
  limit = MAX_SCHEDULES_PER_TICK,
): Promise<ScheduledTask[]> {
  const client = await databasePool().connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<TaskRow>(
      `WITH due AS (
         SELECT id FROM scheduled_tasks
         WHERE status = 'active'
           AND next_run_at <= $2
           AND (lease_expires_at IS NULL OR lease_expires_at <= now())
         ORDER BY next_run_at, id
         LIMIT $3
         FOR UPDATE SKIP LOCKED
       )
       UPDATE scheduled_tasks AS task
       SET lease_owner = $1,
           lease_expires_at = now() + interval '5 minutes',
           updated_at = now()
       FROM due
       WHERE task.id = due.id
       RETURNING task.id, task.public_id, task.owner_telegram_user_id, task.chat_id,
         task.username, task.language_code, task.source_message, task.user_prompt,
         task.metadata, task.status, task.next_run_at, task.last_run_at,
         task.failure_count`,
      [leaseOwner, now, limit],
    );
    const tasks: ScheduledTask[] = [];
    const invalid: string[] = [];
    for (const row of result.rows) {
      const task = mapTask(row);
      if (task) tasks.push(task);
      else invalid.push(row.id);
    }
    if (invalid.length > 0)
      await client.query(
        `UPDATE scheduled_tasks
         SET status = 'paused',
             lease_owner = NULL,
             lease_expires_at = NULL,
             updated_at = now()
         WHERE id = ANY($1::uuid[])`,
        [invalid],
      );
    await client.query("COMMIT");
    return tasks;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function completeSchedule(
  id: string,
  leaseOwner: string,
  nextRunAt: Date,
): Promise<void> {
  await databasePool().query(
    `UPDATE scheduled_tasks
     SET next_run_at = $3,
         last_run_at = now(),
         failure_count = 0,
         lease_owner = NULL,
         lease_expires_at = NULL,
         updated_at = now()
     WHERE id = $1 AND lease_owner = $2`,
    [id, leaseOwner, nextRunAt],
  );
}

export async function failSchedule(
  id: string,
  leaseOwner: string,
  nextRunAt: Date,
): Promise<
  | {
      paused: boolean;
      publicId: string;
      chatId: string;
      metadata: ScheduleMetadata;
    }
  | undefined
> {
  const result = await databasePool().query<{
    status: "active" | "paused";
    public_id: string;
    chat_id: string;
    metadata: unknown;
  }>(
    `UPDATE scheduled_tasks
     SET failure_count = failure_count + 1,
         next_run_at = $3,
         status = CASE WHEN failure_count + 1 >= 3 THEN 'paused' ELSE status END,
         lease_owner = NULL,
         lease_expires_at = NULL,
         updated_at = now()
     WHERE id = $1 AND lease_owner = $2
     RETURNING status, public_id, chat_id, metadata`,
    [id, leaseOwner, nextRunAt],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  const metadata = scheduleMetadataSchema.safeParse(row.metadata);
  if (!metadata.success) return undefined;
  return {
    paused: row.status === "paused",
    publicId: row.public_id,
    chatId: row.chat_id,
    metadata: metadata.data,
  };
}

export async function createScheduledTask(input: {
  ownerTelegramUserId: string;
  chatId: string;
  username: string | null;
  languageCode: string | null;
  sourceMessage: string;
  userPrompt: string;
  metadata: ScheduleMetadata;
  nextRunAt: Date;
}): Promise<
  { ok: true; task: ScheduledTask } | { ok: false; reason: "limit" }
> {
  const client = await databasePool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [
      input.ownerTelegramUserId,
    ]);
    const count = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM scheduled_tasks
       WHERE owner_telegram_user_id = $1`,
      [input.ownerTelegramUserId],
    );
    if ((count.rows[0]?.count ?? 0) >= MAX_SCHEDULES_PER_USER) {
      await client.query("COMMIT");
      return { ok: false, reason: "limit" };
    }
    const task = await insertTask(client, input);
    await client.query("COMMIT");
    return { ok: true, task };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function insertTask(
  client: PoolClient,
  input: {
    ownerTelegramUserId: string;
    chatId: string;
    username: string | null;
    languageCode: string | null;
    sourceMessage: string;
    userPrompt: string;
    metadata: ScheduleMetadata;
    nextRunAt: Date;
  },
): Promise<ScheduledTask> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await client.query("SAVEPOINT schedule_insert");
      const result = await client.query<TaskRow>(
        `INSERT INTO scheduled_tasks (
           id, public_id, owner_telegram_user_id, chat_id, username, language_code,
           source_message, user_prompt, metadata, status, next_run_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 'active', $10
         )
         RETURNING ${COLUMNS}`,
        [
          uuidV7(),
          randomBytes(4).toString("hex"),
          input.ownerTelegramUserId,
          input.chatId,
          input.username,
          input.languageCode,
          input.sourceMessage,
          input.userPrompt,
          JSON.stringify(input.metadata),
          input.nextRunAt,
        ],
      );
      const task = mapTask(result.rows[0]);
      if (!task) throw new Error("SCHEDULE_ROW_INVALID");
      await client.query("RELEASE SAVEPOINT schedule_insert");
      return task;
    } catch (error) {
      await client.query("ROLLBACK TO SAVEPOINT schedule_insert");
      if ((error as { code?: string }).code !== "23505" || attempt === 2)
        throw error;
    }
  }
  throw new Error("SCHEDULE_ID_EXHAUSTED");
}

export async function listSchedulesByOwner(
  userId: string,
): Promise<ScheduledTask[]> {
  const result = await databasePool().query<TaskRow>(
    `SELECT ${COLUMNS} FROM scheduled_tasks
     WHERE owner_telegram_user_id = $1
     ORDER BY status, next_run_at, public_id`,
    [userId],
  );
  return result.rows.flatMap((row) => {
    const task = mapTask(row);
    return task ? [task] : [];
  });
}

export async function setScheduleStatus(
  userId: string,
  publicId: string,
  status: "active" | "paused",
  nextRunAt?: Date,
): Promise<ScheduledTask | undefined> {
  const result = await databasePool().query<TaskRow>(
    `UPDATE scheduled_tasks
     SET status = $3,
         next_run_at = COALESCE($4, next_run_at),
         failure_count = CASE WHEN $3 = 'active' THEN 0 ELSE failure_count END,
         lease_owner = NULL,
         lease_expires_at = NULL,
         updated_at = now()
     WHERE owner_telegram_user_id = $1 AND public_id = $2
     RETURNING ${COLUMNS}`,
    [userId, publicId, status, nextRunAt ?? null],
  );
  const row = result.rows[0];
  return row ? mapTask(row) : undefined;
}

export function postgresScheduleRepository() {
  return {
    create: createScheduledTask,
    listByOwner: listSchedulesByOwner,
    setStatus: setScheduleStatus,
  };
}

function mapTask(row: TaskRow | undefined): ScheduledTask | undefined {
  if (!row) return undefined;
  const metadata = scheduleMetadataSchema.safeParse(row.metadata);
  if (!metadata.success) return undefined;
  return {
    id: row.id,
    publicId: row.public_id,
    ownerTelegramUserId: row.owner_telegram_user_id,
    chatId: row.chat_id,
    username: row.username,
    languageCode: row.language_code,
    sourceMessage: row.source_message,
    userPrompt: row.user_prompt,
    metadata: metadata.data,
    status: row.status,
    nextRunAt: new Date(row.next_run_at),
    lastRunAt: row.last_run_at ? new Date(row.last_run_at) : null,
    failureCount: row.failure_count,
  };
}
