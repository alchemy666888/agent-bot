import { z } from "zod";

export const modelMessageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant"]),
    content: z.string().min(1),
  })
  .strict();
export const modelRequestSchema = z
  .object({
    messages: z.array(modelMessageSchema).min(1),
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
  })
  .strict();
export type ModelRequest = z.infer<typeof modelRequestSchema>;
export type ModelResponse = z.infer<typeof modelResponseSchema>;

export interface ModelProvider {
  generate(request: ModelRequest): Promise<ModelResponse>;
}
