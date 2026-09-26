import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeLayout } from "../../../src/worker/persistence/layout";

export async function temporaryStore(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await initializeLayout(root);
  return root;
}

export function removeStore(root: string): Promise<void> {
  return rm(root, { recursive: true, force: true });
}
