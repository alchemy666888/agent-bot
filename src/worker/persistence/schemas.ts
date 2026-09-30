import { z } from "zod";
import { safeErrorSchema } from "../../shared/contracts";

const safePayload = z
  .record(z.string(), z.unknown())
  .superRefine((value, ctx) => {
    const prohibited =
      /first_name|last_name|authorization|cookie|secret|token|reasoning|raw(update|body|response)/i;
    const hasProhibitedKey = (candidate: unknown): boolean => {
      if (Array.isArray(candidate)) return candidate.some(hasProhibitedKey);
      if (!candidate || typeof candidate !== "object") return false;
      return Object.entries(candidate).some(
        ([key, nested]) => prohibited.test(key) || hasProhibitedKey(nested),
      );
    };
    if (hasProhibitedKey(value))
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
