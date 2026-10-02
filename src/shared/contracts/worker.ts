import { z } from "zod";
import { promptBundleSchema } from "./prompt";

export const degradationNoticeSchema = z.enum([
  "repository_unavailable",
  "catalog_missing",
  "stale_snapshot",
  "catalog_too_large",
  "system_prompt_missing",
  "request_prompt_missing",
  "compiled_emergency_prompt",
]);
export type DegradationNotice = z.infer<typeof degradationNoticeSchema>;

export const workerOperationSchema = z.enum([
  "telegramTurn",
  "query",
  "export",
  "recover",
  "health",
]);
export const workerRequestV1Schema = z
  .object({
    contractVersion: z.literal(1),
    correlationId: z.uuid(),
    operation: workerOperationSchema,
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();
export const workerRequestV2Schema = z
  .object({
    contractVersion: z.literal(2),
    correlationId: z.uuid(),
    operation: workerOperationSchema,
    payload: z.record(z.string(), z.unknown()),
    promptBundle: promptBundleSchema,
    degradationNotices: z.array(degradationNoticeSchema).max(7).default([]),
    rawTelegramInput: z
      .string()
      .max(64 * 1024)
      .optional(),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (
      request.operation === "telegramTurn" &&
      request.rawTelegramInput === undefined
    )
      ctx.addIssue({
        code: "custom",
        path: ["rawTelegramInput"],
        message: "Telegram turns require separate raw input",
      });
  });
export const workerRequestSchema = z.union([
  workerRequestV1Schema,
  workerRequestV2Schema,
]);
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
export const workerResponseV1Schema = z
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
export const workerResponseV2Schema = z
  .object({
    contractVersion: z.literal(2),
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
export const workerResponseSchema = z.union([
  workerResponseV1Schema,
  workerResponseV2Schema,
]);
export type WorkerRequest = z.infer<typeof workerRequestSchema>;
export type WorkerResponse = z.infer<typeof workerResponseSchema>;
