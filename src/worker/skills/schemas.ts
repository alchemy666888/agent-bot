import { z } from "zod";

const safeIdentifier = z.string().trim().min(1).max(200);
const telegramUserIdSchema = z.string().regex(/^\d+$/);
const gitCommitShaSchema = z.string().regex(/^[a-f0-9]{40}$/i);

export const skillTriggerSchema = z
  .object({
    type: z.enum(["command", "keyword", "event"]),
    value: safeIdentifier,
  })
  .strict();

export const skillApprovalSchema = z
  .object({
    approvedBy: safeIdentifier,
    approvedAt: z.iso.datetime(),
    source: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

/** The only document accepted at the durable installation boundary. */
export const approvedSkillDraftSchema = z
  .object({
    stableId: z.uuid(),
    draftId: z.uuid(),
    revision: z.number().int().positive(),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2_000).optional(),
    body: z.string().min(1).max(1_000_000),
    ownerTelegramUserIds: z.array(z.string().regex(/^\d+$/)).min(1),
    triggers: z.array(skillTriggerSchema).max(100).default([]),
    tools: z.array(safeIdentifier).max(100).default([]),
    capabilities: z.array(safeIdentifier).max(100).default([]),
    approval: skillApprovalSchema,
  })
  .strict();

export const installedSkillStatusSchema = z.enum([
  "active",
  "retired",
  "superseded",
]);

export const approvedSkillVersionSchema = approvedSkillDraftSchema.extend({
  versionId: z.uuid(),
  status: installedSkillStatusSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type ApprovedSkillDraft = z.input<typeof approvedSkillDraftSchema>;
export type ApprovedSkillVersion = z.output<typeof approvedSkillVersionSchema>;
export type ApprovedSkillVersionStatus = z.infer<
  typeof installedSkillStatusSchema
>;

/** Repository manifest for an executable skill. `id` is immutable; `name` is not identity. */
export const skillManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.uuid(),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2_000).optional(),
    revision: z.number().int().positive().optional(),
    visibility: z.enum(["private", "shared", "public"]),
    ownerTelegramUserIds: z.array(telegramUserIdSchema).min(1),
    allowedTelegramUserIds: z.array(telegramUserIdSchema).default([]),
    triggers: z
      .object({
        phrases: z.array(safeIdentifier).max(100).default([]),
        keywords: z.array(safeIdentifier).max(100).default([]),
        minimumConfidence: z.number().min(0).max(1),
      })
      .strict(),
    tools: z.array(safeIdentifier).max(100).default([]),
    prohibitedActions: z.array(safeIdentifier).max(100).default([]),
    status: z.enum(["active", "retired"]).default("active"),
    /** Service-authored authorization metadata. PR prose is never authoritative. */
    authoring: z
      .object({
        draftId: z.uuid(),
        approvedRevision: z.number().int().positive(),
        contentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        ownerTelegramUserId: telegramUserIdSchema,
        requestedCapabilities: z.array(safeIdentifier).max(100),
      })
      .strict()
      .optional(),
  })
  .strict();

export const skillMarkdownSchema = z
  .string()
  .min(1)
  .max(1_000_000)
  .refine((value) => value.trim().length > 0, "SKILL.md must not be blank");

/** The single execution-time contract shared by repositories and the resolver. */
export const executableSkillSchema = z
  .object({
    id: z.uuid(),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2_000).optional(),
    commitSha: gitCommitShaSchema,
    manifestRevision: z.number().int().positive().optional(),
    instructions: skillMarkdownSchema,
    visibility: z.enum(["private", "shared", "public"]),
    ownerTelegramUserIds: z.array(telegramUserIdSchema).min(1),
    allowedTelegramUserIds: z.array(telegramUserIdSchema),
    triggers: skillManifestSchema.shape.triggers,
    tools: z.array(safeIdentifier).max(100),
    prohibitedActions: z.array(safeIdentifier).max(100),
    status: z.enum(["active", "retired"]),
  })
  .strict();

export type SkillManifest = z.infer<typeof skillManifestSchema>;
export type ExecutableSkill = z.infer<typeof executableSkillSchema>;

export function normalizeSkillName(name: string): string {
  return name.trim().normalize("NFKC").toLocaleLowerCase("en-US");
}
