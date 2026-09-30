import { z } from "zod";
import { safeErrorSchema } from "../../shared/contracts";

/** Security limits are enforced before skill text reaches durable storage or a model. */
export const MAX_SKILL_DOCUMENT_BYTES = 64 * 1024;
export const capabilityIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/);
export const skillRoleSchema = z.enum([
  "author",
  "approver",
  "owner",
  "consumer",
]);
export const skillContentSchema = z
  .string()
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= MAX_SKILL_DOCUMENT_BYTES,
    "Skill document is too large",
  );
export const skillApprovalSchema = z
  .object({
    draftId: z.uuid(),
    revision: z.number().int().positive(),
    contentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    telegramUserId: z.string().regex(/^\d+$/),
    approvedAt: z.iso.datetime(),
  })
  .strict();
export const installedSkillProvenanceSchema = z
  .object({
    draftId: z.uuid(),
    revision: z.number().int().positive(),
    contentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    authorTelegramUserId: z.string().regex(/^\d+$/),
    ownerTelegramUserId: z.string().regex(/^\d+$/),
    approval: skillApprovalSchema,
    installedAt: z.iso.datetime(),
    grantedCapabilities: z.array(capabilityIdSchema).max(64),
  })
  .strict();
export const securityAuditEventSchema = z
  .object({
    type: z.enum([
      "skill.draft.created",
      "skill.approved",
      "skill.installed",
      "skill.invoked",
      "skill.authorization_denied",
      "telegram.update.replayed",
    ]),
    occurredAt: z.iso.datetime(),
    actorTelegramUserId: z.string().regex(/^\d+$/),
    skillId: z.string().min(1).max(128).optional(),
    draftId: z.uuid().optional(),
    result: z.enum(["success", "denied"]),
    code: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/)
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
