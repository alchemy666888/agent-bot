import { z } from "zod";
import { safeErrorSchema } from "../../shared/contracts";
import { allowedCapabilityIds } from "../../shared/capabilities";

export const MAX_SKILL_DOCUMENT_BYTES = 64 * 1024;
export const MAX_TOOL_OUTPUT_BYTES = 32 * 1024;
const telegramUserIdSchema = z.string().regex(/^\d+$/);
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const boundedDocument = z
  .string()
  .min(1)
  .refine(
    (text) => Buffer.byteLength(text, "utf8") <= MAX_SKILL_DOCUMENT_BYTES,
    "Skill document exceeds size limit",
  );
export const capabilityIdSchema = z.enum(allowedCapabilityIds);
export const skillRoleSchema = z.enum([
  "author",
  "approver",
  "owner",
  "consumer",
]);

export const skillDraftSchema = z
  .object({
    draftId: z.uuid(),
    revision: z.number().int().positive(),
    authorTelegramUserId: telegramUserIdSchema,
    ownerTelegramUserId: telegramUserIdSchema,
    content: boundedDocument,
    contentDigest: digestSchema,
    requestedCapabilities: z
      .array(capabilityIdSchema)
      .max(allowedCapabilityIds.length)
      .refine(
        (items) => new Set(items).size === items.length,
        "Duplicate capability",
      ),
    createdAt: z.iso.datetime(),
  })
  .strict();

/** A server-created attestation bound to immutable content, never approval prose. */
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
    grantedCapabilities: z.array(capabilityIdSchema),
    installedByTelegramUserId: telegramUserIdSchema,
    installedAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.approval.draftId !== value.draft.draftId ||
      value.approval.revision !== value.draft.revision ||
      value.approval.contentDigest !== value.draft.contentDigest
    )
      ctx.addIssue({ code: "custom", message: "Approval provenance mismatch" });
  });

export const toolOutputSchema = z
  .string()
  .refine(
    (text) => Buffer.byteLength(text, "utf8") <= MAX_TOOL_OUTPUT_BYTES,
    "Tool output exceeds size limit",
  );

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

const prohibitedDurableField =
  /first_name|last_name|authorization|cookie|secret|token|password|api.?key|reasoning|raw(update|body|response)|tool.?output/i;

function containsProhibitedField(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsProhibitedField);
  return Object.entries(value).some(
    ([key, nested]) =>
      prohibitedDurableField.test(key) || containsProhibitedField(nested),
  );
}

/** Durable events reject field names likely to contain credentials, raw input, or model/tool internals. */
const safePayload = z
  .record(z.string(), z.unknown())
  .superRefine((value, ctx) => {
    if (containsProhibitedField(value))
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
      "skill-drafts",
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
