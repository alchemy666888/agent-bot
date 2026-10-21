const CLAIM_TTL_MS = 10 * 60_000;
const MAX_CLAIMS = 1_000;
const claimedUpdates = new Map<string, number>();

/** Failure notices are deduplicated only in memory; this path never opens a database. */
export async function webhookFailureClaimed(
  updateId: string,
): Promise<boolean> {
  const expiresAt = claimedUpdates.get(updateId);
  if (expiresAt === undefined) return false;
  if (expiresAt > Date.now()) return true;
  claimedUpdates.delete(updateId);
  return false;
}

export async function claimWebhookFailure(updateId: string): Promise<boolean> {
  const now = Date.now();
  for (const [id, expiresAt] of claimedUpdates)
    if (expiresAt <= now) claimedUpdates.delete(id);
  if (claimedUpdates.has(updateId)) return false;
  if (claimedUpdates.size >= MAX_CLAIMS)
    claimedUpdates.delete(claimedUpdates.keys().next().value!);
  claimedUpdates.set(updateId, now + CLAIM_TTL_MS);
  return true;
}

export async function releaseWebhookFailure(updateId: string): Promise<void> {
  claimedUpdates.delete(updateId);
}

export function resetWebhookFailureClaims(): void {
  claimedUpdates.clear();
}
