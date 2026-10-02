import { describe, expect, it, vi } from "vitest";

import { derivePromptUserKey } from "../../../src/server/prompts/identity";
import { resolveRepositoryTurnContext } from "../../../src/server/telegram/turn-context";
import type { PromptBundle } from "../../../src/shared/contracts/prompt";

const commit = "a".repeat(40);
const identity = {
  connector: "github/shared",
  owner: "owner",
  repository: "repository",
  branch: "main",
};
const secret = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";

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
  it("derives the personal prompt path key and pins authorized skills to one head", async () => {
    const refs: string[] = [];
    const resolvedKeys: string[] = [];
    const context = await resolveRepositoryTurnContext({
      telegramUserId: "424242",
      promptUserKeySecret: secret,
      text: "hello",
      identity,
      promptIdentity: identity,
      skillIdentity: identity,
      resolveHead: async () => commit,
      loadPromptSnapshot: async (ref) => (refs.push(ref), snapshot(ref)),
      resolvePrompt: async (input) => {
        resolvedKeys.push(input.userKey);
        return bundle(input.pinnedSnapshot.commitSha);
      },
      loadSkillCatalog: async (userId, ref) => {
        refs.push(ref);
        // Simulates repository-side authorization: only this actor receives it.
        return { commitSha: ref, skills: userId === "424242" ? [] : [] };
      },
    });
    const userKey = derivePromptUserKey(secret, "424242");
    expect(resolvedKeys).toEqual([userKey]);
    expect(`prompts/users/${userKey}/system/preferences.md`).toMatch(
      /^prompts\/users\/u1_[A-Za-z0-9_-]{43}\/system\/preferences\.md$/,
    );
    expect(refs).toEqual([commit, commit]);
    expect(context.repositoryCommitSha).toBe(commit);
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
      skillIdentity: identity,
      resolveHead,
      loadPromptSnapshot: async (ref) => (observed.push(ref), snapshot(ref)),
      resolvePrompt: async ({ pinnedSnapshot }) =>
        bundle(pinnedSnapshot.commitSha),
      loadSkillCatalog: async (_actor, ref) => (
        observed.push(ref),
        { commitSha: ref, skills: [] }
      ),
    });
    expect(resolveHead).toHaveBeenCalledOnce();
    expect(observed).toEqual([commit, commit]);
  });

  it("rejects identity or immutable-ref disagreement", async () => {
    const base = {
      telegramUserId: "7",
      promptUserKeySecret: secret,
      text: "hello",
      identity,
      promptIdentity: identity,
      skillIdentity: identity,
      resolveHead: async () => commit,
      loadPromptSnapshot: async () => snapshot(),
      resolvePrompt: async () => bundle(commit),
      loadSkillCatalog: async () => ({ commitSha: "b".repeat(40), skills: [] }),
    };
    await expect(resolveRepositoryTurnContext(base)).rejects.toThrow(
      "REPOSITORY_COMMIT_MISMATCH",
    );
    await expect(
      resolveRepositoryTurnContext({
        ...base,
        skillIdentity: { ...identity, repository: "other" },
      }),
    ).rejects.toThrow("REPOSITORY_IDENTITY_MISMATCH");
  });
});
