import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  sanitizeProgress,
  type WorkerProgress,
} from "../../shared/worker-progress";

const PROGRESS_FILE = /^\/tmp\/telegram-agent\/progress\/[A-Za-z0-9-]+\.json$/;

export function workerProgressFile(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const value = env.WORKER_PROGRESS_FILE;
  return value && PROGRESS_FILE.test(value) ? value : undefined;
}

/** Overwrites the command progress file. A killed process keeps the last write. */
export async function writeWorkerProgress(
  progress: WorkerProgress,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const path = workerProgressFile(env);
  const safe = sanitizeProgress(progress);
  if (!path || !safe) return;
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(safe), { mode: 0o600 });
  await rename(temporary, path);
}
