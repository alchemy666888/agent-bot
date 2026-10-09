import type { ExecutableSkill, SkillManifest } from "./schemas";

/** Identity established by the Telegram webhook signature and update parser. */
export interface SkillActor {
  telegramUserId: string;
}

export interface SaveDraftRevisionInput {
  actor: SkillActor;
  manifest: SkillManifest;
  instructions: string;
  /** Revision observed before this write. Zero creates the first revision. */
  expectedRevision: number;
}

export interface PublishedSkillRevision {
  skill: ExecutableSkill;
  versionId: string;
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
    versionId?: string,
  ): Promise<ExecutableSkill | null>;
  listAvailableToTelegramUser(actor: SkillActor): Promise<ExecutableSkill[]>;
  saveDraftRevision(input: SaveDraftRevisionInput): Promise<{
    versionId: string;
    revision: number;
  }>;
  submitForPublish(input: {
    actor: SkillActor;
    skillId: string;
    versionId: string;
    expectedRevision: number;
  }): Promise<{ versionId: string; revision: number }>;
  publishApprovedRevision(input: {
    actor: SkillActor;
    skillId: string;
    expectedRevision: number;
  }): Promise<PublishedSkillRevision>;
  retire(input: {
    actor: SkillActor;
    skillId: string;
    expectedRevision: number;
  }): Promise<{ versionId: string; revision: number }>;
  authorizeInvocation(input: {
    actor: SkillActor;
    skillId: string;
    versionId?: string;
  }): Promise<ExecutableSkill>;
}
