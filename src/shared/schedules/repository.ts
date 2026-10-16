import { randomBytes } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { uuidV7 } from "../ids";
import { postgresPoolConfig } from "../postgres/client";
import { readDatabaseConfig } from "../postgres/config";
import { MAX_SCHEDULES_PER_USER } from "./spec";
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
