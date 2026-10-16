import { openPersistenceStore } from "../../../../shared/postgres/controller-log";
import type { PersistenceStore } from "../../../../shared/postgres/store";

const claimedUpdates = new Set<string>();
let store: PersistenceStore | null | undefined;

/**
 * Controller logs are not copied into the worker scratch, which only syncs
 * `data/` and `logs/worker/`.
 */
export function webhookFailureAckPath(updateId: string): string | undefined {
  if (!/^\d{1,32}$/.test(updateId)) return undefined;
  return `logs/controller/webhook-ack-${updateId}.json`;
}

function failureAckStore(): PersistenceStore | null {
  if (process.env.VITEST) return null;
  if (store !== undefined) return store;
  try {
    store = openPersistenceStore();
  } catch {
    store = null;
  }
  return store;
}

/** True when this update already produced the private failure notice. */
export async function webhookFailureClaimed(
  updateId: string,
): Promise<boolean> {
  if (claimedUpdates.has(updateId)) return true;
  const path = webhookFailureAckPath(updateId);
  const target = path ? failureAckStore() : null;
  if (!path || !target) return false;
  try {
    await target.download(path);
    return true;
  } catch {
    return false;
  }
}

/** Reserves the notice. False when this update was already reserved. */
export async function claimWebhookFailure(
  updateId: string,
  correlationId: string,
): Promise<boolean> {
  if (claimedUpdates.has(updateId)) return false;
  const path = webhookFailureAckPath(updateId);
  if (!path) {
    claimedUpdates.add(updateId);
    return true;
  }
  const target = failureAckStore();
  if (!target) {
    claimedUpdates.add(updateId);
    return true;
  }
  try {
    const won = await target.claim(
      path,
      Buffer.from(JSON.stringify({ updateId, correlationId })),
    );
    if (won) claimedUpdates.add(updateId);
    return won;
  } catch {
    if (claimedUpdates.has(updateId)) return false;
    claimedUpdates.add(updateId);
    return true;
  }
}

export async function releaseWebhookFailure(updateId: string): Promise<void> {
  claimedUpdates.delete(updateId);
  const path = webhookFailureAckPath(updateId);
  const target = path ? failureAckStore() : null;
  if (!path || !target) return;
  try {
    await target.delete(path);
  } catch {
    // A later delivery can send the notice if this release did not land.
  }
}

export function resetWebhookFailureClaims(): void {
  claimedUpdates.clear();
}
