import type { ExecutableSkill, SkillManifest } from "./schemas";

/** Identity established by the Telegram webhook signature and update parser. */
export interface SkillActor {
  telegramUserId: string;
}

export interface SaveDraftRevisionInput {
  actor: SkillActor;
  branch: string;
  directory: string;
  manifest: SkillManifest;
  instructions: string;
  /** Head observed before editing. Required in addition to per-file blob SHAs. */
  expectedBranchSha: string;
  expectedManifestSha?: string | null;
  expectedSkillSha?: string | null;
  expectedIndexSha?: string | null;
  message: string;
}

export interface PublishedSkillRevision {
  skill: ExecutableSkill;
  pullRequestNumber: number;
}

/**
 * The only persistence boundary for skills. Every operation carries the
 * authenticated Telegram principal; callers cannot fetch a document first and
 * make an authorization decision afterwards.
 */
export interface SkillRepository {
  getById(
    actor: SkillActor,
    skillId: string,
    ref?: string,
  ): Promise<ExecutableSkill | null>;
  listAvailableToTelegramUser(
    actor: SkillActor,
    ref?: string,
  ): Promise<ExecutableSkill[]>;
  createDraftBranch(input: {
    actor: SkillActor;
    skillId: string;
    fromRef?: string;
    branch?: string;
  }): Promise<{ branch: string; baseCommitSha: string }>;
  saveDraftRevision(input: SaveDraftRevisionInput): Promise<{
    commitSha: string;
  }>;
  publishApprovedRevision(input: {
    actor: SkillActor;
    pullRequestNumber: number;
    skillId: string;
    expectedMergeCommitSha: string;
  }): Promise<PublishedSkillRevision>;
  retire(input: {
    actor: SkillActor;
    skillId: string;
    branch: string;
    expectedBranchSha: string;
    expectedManifestSha: string;
  }): Promise<{ commitSha: string }>;
  authorizeInvocation(input: {
    actor: SkillActor;
    skillId: string;
    ref?: string;
  }): Promise<ExecutableSkill>;
}
