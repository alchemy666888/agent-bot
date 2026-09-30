import { z } from "zod";

const safeIdentifier = z.string().trim().min(1).max(200);

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

export const installedSkillSchema = approvedSkillDraftSchema.extend({
  versionId: z.uuid(),
  status: installedSkillStatusSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type ApprovedSkillDraft = z.input<typeof approvedSkillDraftSchema>;
export type InstalledSkill = z.output<typeof installedSkillSchema>;
export type InstalledSkillStatus = z.infer<typeof installedSkillStatusSchema>;

export function normalizeSkillName(name: string): string {
  return name.trim().normalize("NFKC").toLocaleLowerCase("en-US");
}
