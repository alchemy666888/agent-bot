import { z } from "zod";
import { safeErrorSchema } from "../../shared/contracts";
import { capabilityIdentifierSchema } from "../../shared/capabilities";

export const MAX_SKILL_DOCUMENT_BYTES = 64 * 1024;
const telegramUserIdSchema = z.string().regex(/^[1-9]\d*$/);
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const skillDocumentSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    instructions: z
      .string()
      .min(1)
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

/** An approval is useful only as a complete, immutable provenance tuple. */
export const skillApprovalSchema = z
  .object({
    draftId: z.uuid(),
    revision: z.number().int().positive(),
    contentDigest: digestSchema,
    telegramUserId: telegramUserIdSchema,
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
    installedAt: z.iso.datetime(),
  })
  .strict();

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
