import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { assertDriveRelativePath } from "../../shared/google-drive/paths";
import { retryDrive } from "../../shared/google-drive/retry";
import type { DriveStore } from "../../shared/google-drive/store";
import { withCommitHook } from "./commit";

const DIRTY = "runtime/drive-dirty";

export async function bindDriveSession<T>(
  root: string,
  store: DriveStore | null,
  action: () => Promise<T>,
): Promise<T> {
  if (!store) return action();
  await syncScratch(root, store);
  let failed = false;
  try {
    return await withCommitHook(async (absolutePath, kind) => {
      try {
        if (kind === "delete") await deleteCommitted(root, absolutePath, store);
        else await uploadCommitted(root, absolutePath, store);
      } catch (error) {
        failed = true;
        await markDirty(root);
        throw error;
      }
    }, action);
  } finally {
    if (!failed) await rm(join(root, DIRTY), { force: true });
  }
}

export async function syncScratch(
  root: string,
  store: DriveStore,
): Promise<void> {
  if (await exists(join(root, "data", "manifest.json"))) {
    await flushDirtyScratch(root, store);
    return;
  }
  for (const file of await store.listFiles(["data/", "logs/worker/"])) {
    assertDriveRelativePath(file.relativePath);
    const destination = join(root, file.relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, await store.download(file.relativePath), {
      mode: 0o600,
    });
  }
}

export async function uploadCommitted(
  root: string,
  absolutePath: string,
  store: DriveStore,
): Promise<void> {
  const relativePath = relativeDrivePath(root, absolutePath);
  if (!relativePath) return;
  assertDriveRelativePath(relativePath);
  const body = await readFile(absolutePath);
  await retryDrive(() => store.upload(relativePath, body));
}

export async function deleteCommitted(
  root: string,
  absolutePath: string,
  store: DriveStore,
): Promise<void> {
  const relativePath = relativeDrivePath(root, absolutePath);
  if (!relativePath) return;
  assertDriveRelativePath(relativePath);
  await retryDrive(() => store.delete(relativePath));
}

async function flushDirtyScratch(
  root: string,
  store: DriveStore,
): Promise<void> {
  if (!(await exists(join(root, DIRTY)))) return;
  await uploadTree(root, join(root, "data"), store);
  await uploadTree(root, join(root, "logs", "worker"), store);
  await rm(join(root, DIRTY), { force: true });
}

async function uploadTree(
  root: string,
  directory: string,
  store: DriveStore,
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const path = join(directory, entry);
    const info = await stat(path);
    if (info.isDirectory()) await uploadTree(root, path, store);
    else if (!entry.endsWith(".tmp")) await uploadCommitted(root, path, store);
  }
}

async function markDirty(root: string): Promise<void> {
  const path = join(root, DIRTY);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "1", { mode: 0o600 });
}

function relativeDrivePath(root: string, absolutePath: string): string | null {
  const relativePath = relative(root, absolutePath).split("\\").join("/");
  if (
    !relativePath ||
    relativePath.startsWith("..") ||
    isAbsolute(relativePath) ||
    relativePath.startsWith("runtime/") ||
    relativePath.endsWith(".tmp")
  )
    return null;
  return relativePath;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
