import "server-only";

import { randomUUID } from "node:crypto";
import { DEFAULT_EMERGENCY_SYSTEM_PROMPT } from "../config";
import type { PostgresPromptRepository } from "./postgres";
import type { GitHubPromptStore, VerifiedPromptSnapshot } from "./github-store";

/** Head checks begin every four minutes, leaving one minute for refresh and skew. */
export const PROMPT_REFRESH_INTERVAL_MS = 4 * 60_000;
export const PROMPT_MAX_STALENESS_MS = 5 * 60_000;
export const PROMPT_REFRESH_LEASE_MS = 45_000;

export type PromptSnapshotResult =
  | {
      source: "current_snapshot" | "verified_snapshot";
      snapshot: VerifiedPromptSnapshot;
    }
  | {
      source: "compiled_emergency";
      snapshot: null;
      emergencySystemPrompt: string;
    };

export class PromptSnapshotCache {
  private current: {
    snapshot: VerifiedPromptSnapshot;
    checkedAt: number;
  } | null = null;
  private refresh: Promise<void> | null = null;

  constructor(
    private readonly store: GitHubPromptStore,
    private readonly repository: PostgresPromptRepository,
    private readonly identity: {
      owner: string;
      name: string;
      prefix: string;
      branch: string;
    },
    private readonly now: () => number = Date.now,
  ) {}

  /** A request may pass its already-pinned snapshot; it always wins. */
  async get(pinned?: VerifiedPromptSnapshot): Promise<PromptSnapshotResult> {
    if (pinned) return { source: "current_snapshot", snapshot: pinned };
    const now = this.now();
    if (
      this.current &&
      now - this.current.checkedAt < PROMPT_REFRESH_INTERVAL_MS
    )
      return { source: "current_snapshot", snapshot: this.current.snapshot };

    if (!this.refresh)
      this.refresh = this.refreshFromGitHub().finally(() => {
        this.refresh = null;
      });
    await this.refresh;
    if (this.current)
      return { source: "current_snapshot", snapshot: this.current.snapshot };

    const stored = await this.repository.getActiveSnapshot(
      this.identity.owner,
      this.identity.name,
      this.identity.prefix,
    );
    if (stored) {
      const snapshot = stored.payload as VerifiedPromptSnapshot;
      this.current = { snapshot, checkedAt: now };
      return { source: "verified_snapshot", snapshot };
    }
    return {
      source: "compiled_emergency",
      snapshot: null,
      emergencySystemPrompt: DEFAULT_EMERGENCY_SYSTEM_PROMPT,
    };
  }

  private async refreshFromGitHub(): Promise<void> {
    const ownerId = randomUUID();
    const acquiredAt = this.now();
    const lease = {
      owner: this.identity.owner,
      name: this.identity.name,
      prefix: this.identity.prefix,
      symbolicRef: this.identity.branch,
      ownerId,
      expiresAt: new Date(acquiredAt + PROMPT_REFRESH_LEASE_MS),
    };
    if (!(await this.repository.acquireRefreshLease(lease))) return;
    try {
      const head = await this.store.resolveHead();
      let snapshot = this.current?.snapshot;
      if (!snapshot || snapshot.commitSha !== head) {
        snapshot = await this.store.load(head);
        await this.repository.activateSnapshot({
          owner: this.identity.owner,
          name: this.identity.name,
          prefix: this.identity.prefix,
          commitSha: snapshot.commitSha,
          payload: snapshot,
          contentDigest: snapshot.contentDigest,
          validatedAt: new Date(snapshot.validatedAt),
        });
      }
      // Deadline is based on completion, while the four-minute check cadence reserves
      // a full minute of the five-minute activation SLO for refresh and clock skew.
      const completedAt = this.now();
      await this.repository.finishRefresh(
        lease,
        snapshot.commitSha,
        new Date(completedAt + PROMPT_REFRESH_INTERVAL_MS),
      );
      this.current = { snapshot, checkedAt: completedAt };
    } catch {
      await this.repository
        .failRefresh(lease, "REFRESH_FAILED")
        .catch(() => undefined);
      // The verified in-memory/DB snapshot remains active. Candidate errors never replace it.
    }
  }
}
