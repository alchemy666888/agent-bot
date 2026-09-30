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
    diagnostic: z
      .object({
        stage: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
        kind: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/),
        causeCode: z
          .string()
          .regex(/^[A-Za-z0-9_.-]{1,64}$/)
          .optional(),
        status: z.number().int().min(100).max(599).optional(),
      })
      .strict()
      .optional(),
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
