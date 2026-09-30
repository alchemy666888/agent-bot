import { z } from "zod";
import { safeErrorSchema } from "../../shared/contracts";
import { allowedCapabilityIds } from "../../shared/capabilities";

export const MAX_SKILL_DOCUMENT_BYTES = 64 * 1024;
export const MAX_TOOL_OUTPUT_BYTES = 32 * 1024;
const boundedDocument = z
  .string()
  .min(1)
  .refine(
    (text) => Buffer.byteLength(text, "utf8") <= MAX_SKILL_DOCUMENT_BYTES,
    "Skill document exceeds size limit",
  );
const capabilitySchema = z.enum(allowedCapabilityIds);

export const skillDraftSchema = z
  .object({
    draftId: z.uuid(),
    revision: z.number().int().positive(),
    authorTelegramUserId: z.string().regex(/^\d+$/),
    ownerTelegramUserId: z.string().regex(/^\d+$/),
    content: boundedDocument,
    contentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    requestedCapabilities: z
      .array(capabilitySchema)
      .max(allowedCapabilityIds.length)
      .refine(
        (items) => new Set(items).size === items.length,
        "Duplicate capability",
      ),
    createdAt: z.iso.datetime(),
  })
  .strict();
export type SkillDraft = z.infer<typeof skillDraftSchema>;

/** An approval is a server-created attestation, never text parsed from a skill. */
export const skillApprovalSchema = z
  .object({
    draftId: z.uuid(),
    revision: z.number().int().positive(),
    contentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    approverTelegramUserId: z.string().regex(/^\d+$/),
    approvedAt: z.iso.datetime(),
  })
  .strict();
export type SkillApproval = z.infer<typeof skillApprovalSchema>;

export const installedSkillSchema = z
  .object({
    skillId: z.uuid(),
    version: z.number().int().positive(),
    draft: skillDraftSchema,
    approval: skillApprovalSchema,
    grantedCapabilities: z.array(capabilitySchema),
    installedByTelegramUserId: z.string().regex(/^\d+$/),
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
export type InstalledSkill = z.infer<typeof installedSkillSchema>;

export const toolOutputSchema = z
  .string()
  .refine(
    (text) => Buffer.byteLength(text, "utf8") <= MAX_TOOL_OUTPUT_BYTES,
    "Tool output exceeds size limit",
  );

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
