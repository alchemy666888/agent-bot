import { z } from "zod";
import { safeErrorSchema } from "../../shared/contracts";

export const MAX_SKILL_DOCUMENT_BYTES = 64 * 1024;
export const MAX_TOOL_OUTPUT_BYTES = 32 * 1024;

/** Operator-maintained identifiers. Skill documents may request, but never define, these. */
export const capabilityIdSchema = z.enum([
  "network.http",
  "telegram.send",
  "storage.read",
  "storage.write",
]);
export const skillRoleSchema = z.enum([
  "author",
  "approver",
  "owner",
  "consumer",
]);
const telegramUserIdSchema = z.string().regex(/^[1-9]\d{0,19}$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const skillDraftSchema = z
  .object({
    draftId: z.uuid(),
    revision: z.number().int().positive(),
    authorTelegramUserId: telegramUserIdSchema,
    content: z.string().min(1).max(MAX_SKILL_DOCUMENT_BYTES),
    contentDigest: sha256Schema,
    requestedCapabilities: z.array(capabilityIdSchema).max(16),
    createdAt: z.iso.datetime(),
  })
  .strict();

export const skillApprovalSchema = z
  .object({
    draftId: z.uuid(),
    revision: z.number().int().positive(),
    contentDigest: sha256Schema,
    approverTelegramUserId: telegramUserIdSchema,
    approvedAt: z.iso.datetime(),
  })
  .strict();

export const installedSkillSchema = z
  .object({
    skillId: z.uuid(),
    ownerTelegramUserId: telegramUserIdSchema,
    content: z.string().min(1).max(MAX_SKILL_DOCUMENT_BYTES),
    grantedCapabilities: z.array(capabilityIdSchema).max(16),
    installedAt: z.iso.datetime(),
    provenance: skillApprovalSchema,
  })
  .strict();

export const securityAuditEventSchema = z
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

const safePayload = z
  .record(z.string(), z.unknown())
  .superRefine((value, ctx) => {
    const serialized = JSON.stringify(value);
    if (
      /first_name|last_name|authorization|cookie|secret|token|reasoning|raw(update|body|response)/i.test(
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
