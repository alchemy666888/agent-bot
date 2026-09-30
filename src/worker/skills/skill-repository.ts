import type { ExecutableSkill, SkillManifest } from "./schemas";

export interface SaveDraftRevisionInput {
  branch: string;
  directory: string;
  manifest: SkillManifest;
  instructions: string;
  expectedManifestSha?: string | null;
  expectedSkillSha?: string | null;
  message: string;
}

export interface PublishedSkillRevision {
  skill: ExecutableSkill;
  pullRequestNumber: number;
}

/** Persistence boundary for the versioned, repository-owned skill catalog. */
export interface SkillRepository {
  getById(skillId: string, ref?: string): Promise<ExecutableSkill | null>;
  listAvailableToTelegramUser(
    userId: string,
    ref?: string,
  ): Promise<ExecutableSkill[]>;
  createDraftBranch(input: {
    skillId: string;
    fromRef?: string;
    branch?: string;
  }): Promise<{ branch: string; baseCommitSha: string }>;
  saveDraftRevision(input: SaveDraftRevisionInput): Promise<{
    commitSha: string;
  }>;
  publishApprovedRevision(input: {
    pullRequestNumber: number;
    skillId: string;
  }): Promise<PublishedSkillRevision>;
  retire(input: {
    skillId: string;
    branch: string;
    actorTelegramUserId: string;
  }): Promise<{ commitSha: string }>;
}
