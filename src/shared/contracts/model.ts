import { z } from "zod";

export const modelMessageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant"]),
    content: z.string().min(1),
  })
  .strict();
export const capabilityRequestSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_.-]*$/),
    description: z.string().min(1).max(500),
    inputSchema: z.record(z.string(), z.unknown()),
  })
  .strict();
export const skillContextSchema = z
  .object({
    id: z.string().min(1),
    version: z.string().min(1),
    instructions: z.string().max(20_000),
    capabilities: z.array(capabilityRequestSchema),
    prohibitedActions: z.array(z.string().min(1)).default([]),
  })
  .strict();
export const modelRequestSchema = z
  .object({
    messages: z.array(modelMessageSchema).min(1),
    skill: skillContextSchema.optional(),
    signal: z.instanceof(AbortSignal).optional(),
  })
  .strict();
export const modelUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  })
  .strict();
export const modelResponseSchema = z
  .object({
    content: z.string().min(1),
    usage: modelUsageSchema.optional(),
    requestId: z.string().min(1).optional(),
    capabilityAudit: z
      .array(
        z.object({
          capabilityId: z.string(),
          outcome: z.enum([
            "success",
            "denied",
            "invalid",
            "timeout",
            "failure",
          ]),
          durationMs: z.number().nonnegative(),
        }),
      )
      .optional(),
  })
  .strict();
export type ModelRequest = z.infer<typeof modelRequestSchema>;
export type ModelResponse = z.infer<typeof modelResponseSchema>;
export type CapabilityRequest = z.infer<typeof capabilityRequestSchema>;
export type SkillContext = z.infer<typeof skillContextSchema>;

export interface ModelProvider {
  generate(request: ModelRequest): Promise<ModelResponse>;
}
