export const skillDraftStatuses = [
  "clarifying",
  "analyzing",
  "draft_ready",
  "awaiting_approval",
  "revision_requested",
  "approved",
  "installed",
  "cancelled",
] as const;

export type SkillDraftStatus = (typeof skillDraftStatuses)[number];

/** The durable, user-owned aggregate used throughout skill authoring. */
export interface SkillDraft {
  id: string;
  ownerTelegramUserId: string;
  skillName: string | null;
  intendedTasksDomain: string | null;
  mustDo: string[];
  mustNotDo: string[];
  betterToDo: string[];
  requiredToolsFunctions: string[];
  unresolvedQuestions: string[];
  draftContent: string | null;
  revisionNumber: number;
  status: SkillDraftStatus;
  createdAt: string;
  updatedAt: string;
  installedAt: string | null;
  lastProcessedUpdateId: string | null;
  lastResponse: string | null;
}

export interface SkillDraftGenerator {
  generateSkillDraft(
    input: SkillDraft,
    revisionFeedback?: string,
  ): Promise<string>;
}
