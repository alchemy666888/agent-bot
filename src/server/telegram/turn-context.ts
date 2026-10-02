import "server-only";

import type { PromptBundle } from "../../shared/contracts/prompt";
import type { SkillCatalogSnapshot } from "../../worker/skills/schemas";
import type { VerifiedPromptSnapshot } from "../prompts/github-store";
import { derivePromptUserKey } from "../prompts/identity";

const SHA = /^[0-9a-f]{40}$/;

export type TurnRepositoryIdentity = {
  connector: string;
  owner: string;
  repository: string;
  branch: string;
};

/** Resolves one mutable head, then uses only that immutable ref for the turn. */
export async function resolveRepositoryTurnContext(input: {
  telegramUserId: string;
  promptUserKeySecret: string;
  text: string;
  language?: string;
  correlationId?: string;
  identity: TurnRepositoryIdentity;
  promptIdentity: TurnRepositoryIdentity;
  skillIdentity: TurnRepositoryIdentity;
  resolveHead(): Promise<string>;
  loadPromptSnapshot(commitSha: string): Promise<VerifiedPromptSnapshot>;
  resolvePrompt(input: {
    userKey: string;
    text: string;
    language?: string;
    correlationId?: string;
    pinnedSnapshot: VerifiedPromptSnapshot;
  }): Promise<Readonly<PromptBundle>>;
  loadSkillCatalog(
    telegramUserId: string,
    commitSha: string,
  ): Promise<SkillCatalogSnapshot>;
}) {
  const expected = JSON.stringify(input.identity);
  if (
    JSON.stringify(input.promptIdentity) !== expected ||
    JSON.stringify(input.skillIdentity) !== expected
  )
    throw new Error("REPOSITORY_IDENTITY_MISMATCH");
  const commitSha = await input.resolveHead();
  if (!SHA.test(commitSha)) throw new Error("INVALID_REPOSITORY_COMMIT");
  const snapshot = await input.loadPromptSnapshot(commitSha);
  const userKey = derivePromptUserKey(
    input.promptUserKeySecret,
    input.telegramUserId,
  );
  const [promptBundle, skillCatalog] = await Promise.all([
    input.resolvePrompt({
      userKey,
      text: input.text,
      pinnedSnapshot: snapshot,
      ...(input.language ? { language: input.language } : {}),
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    }),
    input.loadSkillCatalog(input.telegramUserId, commitSha),
  ]);
  if (
    snapshot.commitSha !== commitSha ||
    promptBundle.repositoryCommitSha !== commitSha ||
    skillCatalog.commitSha !== commitSha
  )
    throw new Error("REPOSITORY_COMMIT_MISMATCH");
  return {
    userKey,
    repositoryCommitSha: commitSha,
    promptBundle,
    skillCatalog,
  };
}
