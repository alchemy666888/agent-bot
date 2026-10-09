import { describe, expect, it, vi } from "vitest";

import { derivePromptUserKey } from "../../../src/server/prompts/identity";
import { resolveRepositoryTurnContext } from "../../../src/server/telegram/turn-context";
import type { PromptBundle } from "../../../src/shared/contracts/prompt";
import { EMPTY_SKILL_CATALOG_TOKEN } from "../../../src/worker/skills/schemas";

const commit = "a".repeat(40);
const identity = {
  connector: "github/shared",
  owner: "owner",
  repository: "repository",
  branch: "main",
};
const secret = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";
const emptyCatalog = {
  catalogToken: EMPTY_SKILL_CATALOG_TOKEN,
  skills: [],
};

function bundle(sha: string): PromptBundle {
  return {
    schemaVersion: 1,
    runtimePolicy: { version: "1", mode: "normal" },
    commonSystemPrompt: {
      id: "base",
      content: "base",
      source: "repository",
      blobSha: commit,
    },
    requestTemplate: {
      id: "default",
      content: "request",
      source: "repository",
      blobSha: commit,
    },
    trustedRuntimeContext: [],
    repositoryCommitSha: sha,
    selectedBlobShas: [],
    resolutionSource: "default",
    degradedModeSource: null,
    turnPin: { commitSha: sha, pinnedAt: new Date(0).toISOString() },
    telemetry: { resolution: "deterministic", degraded: false },
  };
}

const snapshot = (sha = commit) => ({
  commitSha: sha,
  files: [],
  contentDigest: "digest",
  validatedAt: new Date(0).toISOString(),
});

describe("repository-backed Telegram turn context", () => {
  it("derives the personal prompt path key and loads skills independently of the prompt head", async () => {
    const refs: string[] = [];
    const resolvedKeys: string[] = [];
    const context = await resolveRepositoryTurnContext({
      telegramUserId: "424242",
      promptUserKeySecret: secret,
      text: "hello",
      identity,
      promptIdentity: identity,
      resolveHead: async () => commit,
      loadPromptSnapshot: async (ref) => (refs.push(ref), snapshot(ref)),
      resolvePrompt: async (input) => {
        resolvedKeys.push(input.userKey);
        return bundle(input.pinnedSnapshot.commitSha);
      },
      loadSkillCatalog: async (userId) => {
        refs.push(userId);
        return emptyCatalog;
      },
    });
    const userKey = derivePromptUserKey(secret, "424242");
    expect(resolvedKeys).toEqual([userKey]);
    expect(`prompts/users/${userKey}/system/preferences.md`).toMatch(
      /^prompts\/users\/u1_[A-Za-z0-9_-]{43}\/system\/preferences\.md$/,
    );
    expect(refs).toEqual([commit, "424242"]);
    expect(context.repositoryCommitSha).toBe(commit);
    expect(context.skillCatalog).toEqual(emptyCatalog);
  });

  it("is unaffected by branch movement after its single head read", async () => {
    const resolveHead = vi.fn().mockResolvedValueOnce(commit);
    const observed: string[] = [];
    await resolveRepositoryTurnContext({
      telegramUserId: "7",
      promptUserKeySecret: secret,
      text: "hello",
      identity,
      promptIdentity: identity,
      resolveHead,
      loadPromptSnapshot: async (ref) => (observed.push(ref), snapshot(ref)),
      resolvePrompt: async ({ pinnedSnapshot }) =>
        bundle(pinnedSnapshot.commitSha),
      loadSkillCatalog: async () => emptyCatalog,
    });
    expect(resolveHead).toHaveBeenCalledOnce();
    expect(observed).toEqual([commit]);
  });

  it("rejects prompt identity or immutable-ref disagreement", async () => {
    const base = {
      telegramUserId: "7",
      promptUserKeySecret: secret,
      text: "hello",
      identity,
      promptIdentity: identity,
      resolveHead: async () => commit,
      loadPromptSnapshot: async () => snapshot(),
      resolvePrompt: async () => bundle("b".repeat(40)),
      loadSkillCatalog: async () => emptyCatalog,
    };
    await expect(resolveRepositoryTurnContext(base)).rejects.toThrow(
      "REPOSITORY_COMMIT_MISMATCH",
    );
    await expect(
      resolveRepositoryTurnContext({
        ...base,
        resolvePrompt: async () => bundle(commit),
        promptIdentity: { ...identity, repository: "other" },
      }),
    ).rejects.toThrow("REPOSITORY_IDENTITY_MISMATCH");
  });
});
