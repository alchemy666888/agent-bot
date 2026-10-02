import { describe, expect, it, vi } from "vitest";
import {
  PROMPT_REFRESH_INTERVAL_MS,
  PROMPT_MAX_STALENESS_MS,
  PromptSnapshotCache,
} from "../../../src/server/prompts/cache";
import type { VerifiedPromptSnapshot } from "../../../src/server/prompts/github-store";
import type { PostgresPromptRepository } from "../../../src/server/prompts/postgres";
import type { GitHubPromptStore } from "../../../src/server/prompts/github-store";

const SHA = "d".repeat(40);
const snapshot: VerifiedPromptSnapshot = {
  commitSha: SHA,
  files: [],
  contentDigest: "e".repeat(64),
  validatedAt: new Date(0).toISOString(),
};
const identity = {
  owner: "owner",
  name: "skill",
  prefix: "prompts",
  branch: "main",
};

function dependencies(options: { fail?: boolean; stored?: boolean } = {}) {
  const store = {
    resolveHead: vi.fn(async () => {
      if (options.fail) throw new Error("outage");
      return SHA;
    }),
    load: vi.fn(async () => snapshot),
  } as unknown as GitHubPromptStore;
  const repository = {
    acquireRefreshLease: vi.fn(async () => true),
    activateSnapshot: vi.fn(async () => undefined),
    finishRefresh: vi.fn(async () => undefined),
    failRefresh: vi.fn(async () => undefined),
    getActiveSnapshot: vi.fn(async () =>
      options.stored
        ? {
            ...identity,
            id: "1",
            commitSha: SHA,
            payload: snapshot,
            contentDigest: snapshot.contentDigest,
            validatedAt: new Date(0),
          }
        : null,
    ),
  } as unknown as PostgresPromptRepository;
  return { store, repository };
}

describe("PromptSnapshotCache refresh", () => {
  it("reserves refresh time inside the explicit five-minute SLO", () => {
    expect(PROMPT_REFRESH_INTERVAL_MS).toBeLessThan(PROMPT_MAX_STALENESS_MS);
    expect(PROMPT_MAX_STALENESS_MS).toBe(5 * 60_000);
  });

  it("falls back to the compiled emergency prompt on outage without a snapshot", async () => {
    const { store, repository } = dependencies({ fail: true });
    const cache = new PromptSnapshotCache(store, repository, identity);
    await expect(cache.get()).resolves.toMatchObject({
      source: "compiled_emergency",
      snapshot: null,
    });
    expect(repository.activateSnapshot).not.toHaveBeenCalled();
  });

  it("uses the last verified PostgreSQL snapshot when refresh fails", async () => {
    const { store, repository } = dependencies({ fail: true, stored: true });
    const cache = new PromptSnapshotCache(store, repository, identity);
    await expect(cache.get()).resolves.toEqual({
      source: "verified_snapshot",
      snapshot,
    });
  });

  it("coalesces concurrent refreshes and does not duplicate GitHub reads", async () => {
    const { store, repository } = dependencies();
    const cache = new PromptSnapshotCache(store, repository, identity);
    const [first, second, third] = await Promise.all([
      cache.get(),
      cache.get(),
      cache.get(),
    ]);
    expect([first, second, third]).toEqual([
      { source: "current_snapshot", snapshot },
      { source: "current_snapshot", snapshot },
      { source: "current_snapshot", snapshot },
    ]);
    expect(store.resolveHead).toHaveBeenCalledTimes(1);
    expect(store.load).toHaveBeenCalledTimes(1);
    expect(repository.acquireRefreshLease).toHaveBeenCalledTimes(1);
  });

  it("checks the immutable head after four minutes and reuses an unchanged snapshot", async () => {
    let now = 0;
    const { store, repository } = dependencies();
    const cache = new PromptSnapshotCache(
      store,
      repository,
      identity,
      () => now,
    );
    await cache.get();
    now = PROMPT_REFRESH_INTERVAL_MS + 1;
    await cache.get();
    expect(store.resolveHead).toHaveBeenCalledTimes(2);
    expect(store.load).toHaveBeenCalledTimes(1);
    expect(repository.activateSnapshot).toHaveBeenCalledTimes(1);
  });
});
