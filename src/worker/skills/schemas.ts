import { createHash } from "node:crypto";
import { z } from "zod";

const migratedStatusSchema = z.enum(["active", "retired", "superseded"]);
const migratedTriggerSchema = z
  .object({
    type: z.enum(["command", "keyword", "event"]),
    value: z.string().min(1),
  })
  .strict();
const migratedApprovalSchema = z
  .object({
    approvedBy: z.string().min(1),
    approvedAt: z.iso.datetime(),
    source: z.string().optional(),
  })
  .strict();

const safeIdentifier = z.string().trim().min(1).max(200);
const telegramUserIdSchema = z.string().regex(/^\d+$/);
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
    /** Immutable provenance written by the one-time PostgreSQL-to-Git migration. */
    migration: z
      .object({
        sourceVersionId: z.uuid(),
        sourceVersionNumber: z.number().int().positive(),
        sourceStatus: migratedStatusSchema,
        sourceContentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        sourceTriggers: z.array(migratedTriggerSchema).max(100),
        capabilities: z.array(safeIdentifier).max(100),
        approval: migratedApprovalSchema,
        createdAt: z.iso.datetime(),
        updatedAt: z.iso.datetime(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    if (
      new Set(manifest.ownerTelegramUserIds).size !==
      manifest.ownerTelegramUserIds.length
    )
      ctx.addIssue({
        code: "custom",
        path: ["ownerTelegramUserIds"],
        message: "Skill owners must be unique",
      });
    if (
      new Set(manifest.allowedTelegramUserIds).size !==
      manifest.allowedTelegramUserIds.length
    )
      ctx.addIssue({
        code: "custom",
        path: ["allowedTelegramUserIds"],
        message: "Allowed users must be unique",
      });
    if (
      manifest.authoring &&
      !manifest.ownerTelegramUserIds.includes(
        manifest.authoring.ownerTelegramUserId,
      )
    )
      ctx.addIssue({
        code: "custom",
        path: ["authoring", "ownerTelegramUserId"],
        message: "The authoring owner must own the skill",
      });
    if (
      manifest.authoring &&
      (new Set(manifest.authoring.requestedCapabilities).size !==
        manifest.tools.length ||
        manifest.tools.some(
          (tool) => !manifest.authoring!.requestedCapabilities.includes(tool),
        ))
    )
      ctx.addIssue({
        code: "custom",
        path: ["authoring", "requestedCapabilities"],
        message: "Approved capabilities must match executable tools",
      });
  });

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
    versionId: z.uuid(),
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
  .strict()
  .superRefine((skill, ctx) => {
    if (
      new Set(skill.ownerTelegramUserIds).size !==
      skill.ownerTelegramUserIds.length
    )
      ctx.addIssue({
        code: "custom",
        path: ["ownerTelegramUserIds"],
        message: "Skill owners must be unique",
      });
    if (
      new Set(skill.allowedTelegramUserIds).size !==
      skill.allowedTelegramUserIds.length
    )
      ctx.addIssue({
        code: "custom",
        path: ["allowedTelegramUserIds"],
        message: "Allowed users must be unique",
      });
    if (new Set(skill.tools).size !== skill.tools.length)
      ctx.addIssue({
        code: "custom",
        path: ["tools"],
        message: "Skill capabilities must be unique",
      });
    if (skill.visibility === "private" && skill.allowedTelegramUserIds.length)
      ctx.addIssue({
        code: "custom",
        path: ["allowedTelegramUserIds"],
        message: "Private skills cannot grant shared access",
      });
  });

/** Digest of the version ids in one authorized catalog snapshot. */
export function skillCatalogToken(versionIds: readonly string[]): string {
  return createHash("sha256")
    .update([...versionIds].sort().join("\n"), "utf8")
    .digest("hex");
}

export const EMPTY_SKILL_CATALOG_TOKEN = skillCatalogToken([]);

const catalogTokenSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const skillCatalogSnapshotSchema = z
  .object({
    catalogToken: catalogTokenSchema,
    skills: z.array(executableSkillSchema).max(10_000),
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    const ids = new Set<string>();
    snapshot.skills.forEach((skill, index) => {
      if (ids.has(skill.id))
        ctx.addIssue({
          code: "custom",
          path: ["skills", index, "id"],
          message: "Duplicate skill ID",
        });
      ids.add(skill.id);
    });
    if (
      snapshot.catalogToken !==
      skillCatalogToken(snapshot.skills.map((skill) => skill.versionId))
    )
      ctx.addIssue({
        code: "custom",
        path: ["catalogToken"],
        message: "Catalog token does not match the pinned skill versions",
      });
  });

export type SkillManifest = z.infer<typeof skillManifestSchema>;
export type ExecutableSkill = z.infer<typeof executableSkillSchema>;
export type SkillCatalogSnapshot = z.infer<typeof skillCatalogSnapshotSchema>;

export function normalizeSkillName(name: string): string {
  return name.trim().normalize("NFKC").toLocaleLowerCase("en-US");
}
