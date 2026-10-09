import { createHash } from "node:crypto";
import { alignSkillMarkdown, markdownIdentity } from "./markdown";
import { skillManifestSchema, skillMarkdownSchema } from "./schemas";
import type { SkillDraft } from "./types";

export function skillDraftDigest(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

export function prepareSkillRevision(draft: SkillDraft, content: string) {
  if (!draft.skillName) throw new Error("SKILL_DRAFT_INCOMPLETE");
  const revision = draft.revisionNumber + 1;
  const document = skillMarkdownSchema.parse(
    alignSkillMarkdown(
      content,
      draft.skillName,
      draft.intendedTasksDomain?.trim() || "Custom skill",
    ),
  );
  const contentDigest = skillDraftDigest(document);
  const identity = markdownIdentity(document);
  if (identity.name !== draft.skillName)
    throw new Error("SKILL_MARKDOWN_MANIFEST_MISMATCH");
  const manifest = skillManifestSchema.parse({
    schemaVersion: 1,
    id: draft.stableId,
    name: draft.skillName,
    description: identity.description,
    revision,
    visibility: "private",
    ownerTelegramUserIds: [draft.ownerTelegramUserId],
    allowedTelegramUserIds: [],
    triggers: { phrases: [], keywords: [], minimumConfidence: 1 },
    tools: draft.requiredToolsFunctions,
    prohibitedActions: draft.mustNotDo,
    status: "active",
    authoring: {
      draftId: draft.id,
      approvedRevision: revision,
      contentDigest,
      ownerTelegramUserId: draft.ownerTelegramUserId,
      requestedCapabilities: draft.requiredToolsFunctions,
    },
  });
  return { document, manifest, contentDigest, revision };
}
