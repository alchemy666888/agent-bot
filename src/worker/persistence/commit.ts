import { AsyncLocalStorage } from "node:async_hooks";

type CommitHook = (
  absolutePath: string,
  action: "upload" | "delete",
) => Promise<void>;

const hooks = new AsyncLocalStorage<CommitHook>();

export function withCommitHook<T>(
  hook: CommitHook,
  action: () => Promise<T>,
): Promise<T> {
  return hooks.run(hook, action);
}

export async function notifyCommit(absolutePath: string): Promise<void> {
  await hooks.getStore()?.(absolutePath, "upload");
}

export async function notifyRemove(absolutePath: string): Promise<void> {
  await hooks.getStore()?.(absolutePath, "delete");
}
