import { logStructured, type LogRecord } from "../logger";
import { createPostgresStore } from "./client";
import { readDatabaseConfig } from "./config";
import { retryPersistence } from "./retry";
import type { PersistenceStore } from "./store";

export function controllerLogPath(record: LogRecord): string {
  if (!/^[A-Za-z0-9-]+$/.test(record.correlationId))
    throw new Error("PERSISTENCE_PATH_REJECTED");
  const stage =
    record.stage
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "event";
  return `logs/controller/${record.correlationId}-${stage}.json`;
}

export function openPersistenceStore(
  env: Record<string, string | undefined> = process.env,
): PersistenceStore | null {
  if (!env.DATABASE_URL) return null;
  const config = readDatabaseConfig(env);
  return createPostgresStore(config.DATABASE_URL, config.AIVEN_PG_CA);
}

/** Creates one persistence record per controller event. Missing config does not change the HTTP result. */
export async function persistControllerLog(
  record: LogRecord,
  store?: PersistenceStore,
): Promise<void> {
  const line = logStructured(record);
  const target = store ?? (process.env.VITEST ? null : openPersistenceStore());
  if (!target) return;
  try {
    await retryPersistence(() =>
      target.upload(controllerLogPath(record), Buffer.from(line)),
    );
  } catch (error) {
    if (store) throw error;
  }
}
