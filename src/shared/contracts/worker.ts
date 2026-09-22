import { z } from "zod";

export const workerOperationSchema = z.enum([
  "telegramTurn",
  "query",
  "export",
  "recover",
  "health",
]);
export const workerRequestSchema = z
  .object({
    contractVersion: z.literal(1),
    correlationId: z.uuid(),
    operation: workerOperationSchema,
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();
export const safeErrorSchema = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    classification: z.enum([
      "validation",
      "authentication",
      "transient",
      "permanent",
      "internal",
    ]),
    message: z.string().max(256),
  })
  .strict();
export const workerResponseSchema = z
  .object({
    contractVersion: z.literal(1),
    correlationId: z.uuid(),
    ok: z.boolean(),
    data: z.record(z.string(), z.unknown()).optional(),
    error: safeErrorSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.ok === Boolean(value.error))
      ctx.addIssue({
        code: "custom",
        message: "Exactly one success result or safe error is required",
      });
  });
export type WorkerRequest = z.infer<typeof workerRequestSchema>;
export type WorkerResponse = z.infer<typeof workerResponseSchema>;
