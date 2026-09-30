import { mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { logStructured, type LogRecord } from "../../shared/logger";
import type { PersistenceStore } from "../../shared/postgres/store";
import { LockCoordinator } from "../locks/coordinator";
import { notifyCommit } from "../persistence/commit";

export async function writeWorkerLog(
  root: string,
  record: LogRecord,
  store: PersistenceStore | null,
): Promise<void> {
  const line = logStructured(record);
  if (!store) return;
  const locks = new LockCoordinator(root);
  await locks.withMutation(async () => {
    const month = new Date().toISOString().slice(0, 7);
    const path = join(root, "logs", "worker", `${month}.jsonl`);
    await mkdir(dirname(path), { recursive: true });
    const file = await open(path, "a", 0o600);
    try {
      await file.write(`${line}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await notifyCommit(path);
  });
}
