import { z } from "zod";
import { safeErrorSchema } from "../../shared/contracts";

/** Security limits are enforced before any skill document reaches a model. */
export const MAX_SKILL_DOCUMENT_BYTES = 64 * 1024;
export const MAX_TOOL_OUTPUT_BYTES = 32 * 1024;
export const capabilityIds = [
  "network.http",
  "telegram.send",
  "storage.read",
  "storage.write",
] as const;
export const capabilityIdSchema = z.enum(capabilityIds);
export const skillRoleSchema = z.enum([
  "author",
  "approver",
  "owner",
  "consumer",
]);
const telegramUserIdSchema = z.string().regex(/^\d+$/);
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const skillDraftSchema = z
  .object({
    draftId: z.uuid(),
    revision: z.number().int().positive(),
    authorTelegramUserId: telegramUserIdSchema,
    ownerTelegramUserId: telegramUserIdSchema,
    content: z.string().min(1).max(MAX_SKILL_DOCUMENT_BYTES),
    contentDigest: digestSchema,
    requestedCapabilities: z
      .array(capabilityIdSchema)
      .max(capabilityIds.length),
    createdAt: z.iso.datetime(),
  })
  .strict();

/** Approval is structured provenance, never text extracted from a chat or model. */
export const skillApprovalSchema = z
  .object({
    draftId: z.uuid(),
    revision: z.number().int().positive(),
    contentDigest: digestSchema,
    approverTelegramUserId: telegramUserIdSchema,
    approvedAt: z.iso.datetime(),
  })
  .strict();

export const installedSkillSchema = z
  .object({
    skillId: z.uuid(),
    version: z.number().int().positive(),
    draft: skillDraftSchema,
    approval: skillApprovalSchema,
    installedByTelegramUserId: telegramUserIdSchema,
    installedAt: z.iso.datetime(),
    grantedCapabilities: z.array(capabilityIdSchema),
  })
  .strict();

export const auditEventSchema = z
  .object({
    eventId: z.uuid(),
    occurredAt: z.iso.datetime(),
    actorTelegramUserId: telegramUserIdSchema.optional(),
    action: z.enum([
      "skill.draft.created",
      "skill.draft.revised",
      "skill.approved",
      "skill.installed",
      "skill.invoked",
      "skill.authorization_denied",
      "telegram.update.replayed",
    ]),
    result: z.enum(["success", "denied"]),
    skillId: z.uuid().optional(),
    draftId: z.uuid().optional(),
    revision: z.number().int().positive().optional(),
    contentDigest: digestSchema.optional(),
    reasonCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
      .optional(),
    capabilities: z.array(capabilityIdSchema).optional(),
  })
  .strict();

const safePayload = z
  .record(z.string(), z.unknown())
  .superRefine((value, ctx) => {
    const serialized = JSON.stringify(value);
    if (
      /first_name|last_name|authorization|cookie|secret|token|password|api.?key|reasoning|raw(update|body|response)|tool.?output/i.test(
        serialized,
      )
    )
      ctx.addIssue({ code: "custom", message: "Prohibited durable field" });
  });
export const eventSchema = z
  .object({
    schemaVersion: z.literal(1),
    eventId: z.uuid(),
    entityId: z.string().min(1),
    kind: z.enum([
      "users",
      "conversations",
      "messages",
      "updates",
      "model-runs",
      "errors",
    ]),
    type: z.string().min(1),
    occurredAt: z.iso.datetime(),
    revision: z.number().int().positive(),
    payload: safePayload,
    error: safeErrorSchema.optional(),
  })
  .strict();
export type DurableEvent = z.infer<typeof eventSchema>;
export type SkillDraft = z.infer<typeof skillDraftSchema>;
export type SkillApproval = z.infer<typeof skillApprovalSchema>;
export type InstalledSkill = z.infer<typeof installedSkillSchema>;
export type CapabilityId = z.infer<typeof capabilityIdSchema>;
export type AuditEvent = z.infer<typeof auditEventSchema>;
