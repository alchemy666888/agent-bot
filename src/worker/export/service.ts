import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { LockCoordinator } from "../locks/coordinator";
import { createZip, syncFile } from "./zip";

export interface ExportResult {
  archivePath: string;
  filename: string;
  size: number;
}

async function syncTree(path: string): Promise<void> {
  const info = await stat(path);
  if (info.isFile()) return syncFile(path);
  if (!info.isDirectory()) throw new Error("EXPORT_FILE_TYPE_REJECTED");
  for (const entry of await readdir(path)) await syncTree(join(path, entry));
  await syncFile(path);
}

export async function exportData(options: {
  root: string;
  runtimeRoot?: string;
  now?: Date;
  locks?: LockCoordinator;
}): Promise<ExportResult> {
  const now = options.now ?? new Date();
  const runtimeRoot = options.runtimeRoot ?? "/tmp/telegram-agent/exports";
  const exportRoot = join(runtimeRoot, randomUUID());
  const snapshot = join(exportRoot, "data");
  const archivePath = join(exportRoot, "archive.zip");
  await mkdir(exportRoot, { recursive: true, mode: 0o700 });
  try {
    await (options.locks ?? new LockCoordinator(options.root)).withExport(
      async () => {
        const source = join(options.root, "data");
        await syncTree(source);
        await cp(source, snapshot, { recursive: true, errorOnExist: true });
      },
    );
    const size = await createZip(snapshot, archivePath);
    return {
      archivePath,
      filename: `telegram-agent-data-${now.toISOString().replace(/[:.]/g, "-")}.zip`,
      size,
    };
  } catch (error) {
    await rm(exportRoot, { recursive: true, force: true });
    throw error;
  }
}
