import { logStructured, type LogRecord } from "../logger";
import { createGoogleDriveClient } from "./client";
import { readGoogleDriveConfig } from "./config";
import { retryDrive } from "./retry";
import type { DriveStore } from "./store";

export function controllerLogPath(record: LogRecord): string {
  if (!/^[A-Za-z0-9-]+$/.test(record.correlationId))
    throw new Error("DRIVE_PATH_REJECTED");
  const stage =
    record.stage
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "event";
  return `logs/controller/${record.correlationId}-${stage}.json`;
}

export function openDriveStore(
  env: Record<string, string | undefined> = process.env,
): DriveStore | null {
  if (!env.GOOGLE_CLIENT_ID) return null;
  return createGoogleDriveClient(readGoogleDriveConfig(env));
}

/** Creates one Drive file per controller event. Missing config does not change the HTTP result. */
export async function persistControllerLog(
  record: LogRecord,
  store?: DriveStore,
): Promise<void> {
  const line = logStructured(record);
  const target = store ?? (process.env.VITEST ? null : openDriveStore());
  if (!target) return;
  try {
    await retryDrive(() =>
      target.upload(controllerLogPath(record), Buffer.from(line)),
    );
  } catch (error) {
    if (store) throw error;
  }
}
