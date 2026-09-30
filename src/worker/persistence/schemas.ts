import { z } from "zod";
import { safeErrorSchema } from "../../shared/contracts";
import { capabilityIdentifierSchema } from "../../shared/capabilities";

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

export const skillDocumentSchema = z
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
        (value) => Buffer.byteLength(value, "utf8") <= MAX_SKILL_DOCUMENT_BYTES,
        {
          message: "Skill document exceeds configured size limit",
        },
      ),
    requestedCapabilities: z
      .array(capabilityIdentifierSchema)
      .max(16)
      .default([]),
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
    ownerTelegramUserId: telegramUserIdSchema,
    document: skillDocumentSchema,
    contentDigest: digestSchema,
    grantedCapabilities: z.array(capabilityIdentifierSchema),
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

export const securityAuditEventSchema = z
  .object({
    eventId: z.uuid(),
    occurredAt: z.iso.datetime(),
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
    actorTelegramUserId: telegramUserIdSchema.optional(),
    skillId: z.uuid().optional(),
    draftId: z.uuid().optional(),
    reasonCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
      .optional(),
    metadata: z.record(
      z.string(),
      z.union([z.string().max(256), z.number(), z.boolean()]),
    ),
  })
  .strict();

export const auditEventSchema = z
  .object({
    event: z.enum([
      "skill.draft.created",
      "skill.approval.granted",
      "skill.install.allowed",
      "skill.install.denied",
      "skill.invoke.allowed",
      "skill.invoke.denied",
      "telegram.update.replayed",
    ]),
    actorTelegramUserId: telegramUserIdSchema.optional(),
    draftId: z.uuid().optional(),
    skillId: z.uuid().optional(),
    revision: z.number().int().positive().optional(),
    contentDigest: sha256Schema.optional(),
    reasonCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
      .optional(),
  })
  .strict();

/** Durable events reject fields likely to contain credentials, raw input, or model/tool internals. */
const safePayload = z
  .record(z.string(), z.unknown())
  .superRefine((value, ctx) => {
    if (
      /first_name|last_name|authorization|cookie|secret|token|password|api.?key|reasoning|raw(update|body|response)|tool.?output/i.test(
        JSON.stringify(value),
      )
    )
      ctx.addIssue({ code: "custom", message: "Prohibited durable field" });
  });

export const MAX_SKILL_DOCUMENT_BYTES = 64 * 1024;
export const MAX_TOOL_OUTPUT_BYTES = 32 * 1024;

export const approvalProvenanceSchema = z
  .object({
    draftId: z.uuid(),
    revision: z.number().int().positive(),
    contentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    telegramUserId: z.string().regex(/^\d+$/),
    approvedAt: z.iso.datetime(),
  })
  .strict();

export const skillAuditEventSchema = z
  .object({
    event: z.enum([
      "skill.draft.created",
      "skill.approval.accepted",
      "skill.approval.rejected",
      "skill.install.accepted",
      "skill.install.rejected",
      "skill.invoke.accepted",
      "skill.invoke.rejected",
    ]),
    occurredAt: z.iso.datetime(),
    actorTelegramUserId: z.string().regex(/^\d+$/),
    skillId: z.uuid().optional(),
    draftId: z.uuid().optional(),
    revision: z.number().int().positive().optional(),
    reasonCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
      .optional(),
  })
  .strict();
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
      "audit",
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
