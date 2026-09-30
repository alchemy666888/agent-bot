import { z } from "zod";
import { safeErrorSchema } from "../../shared/contracts";

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
