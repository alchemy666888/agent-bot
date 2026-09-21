import "server-only";

import { z } from "zod";

export const SANDBOX_REGION = "sin1" as const;
export const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful, accurate, and safe general-purpose assistant. Reply in the language of the user's latest message unless they request another language.";

const requiredString = z.string().trim().min(1);
const price = z
  .string()
  .trim()
  .min(1)
  .transform(Number)
  .pipe(z.number().finite().nonnegative());
const strictBoolean = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

const modelSchema = z.object({
  DEEPSEEK_API_KEY: requiredString,
  ASSISTANT_SYSTEM_PROMPT: requiredString.default(DEFAULT_SYSTEM_PROMPT),
  DEEPSEEK_THINKING_ENABLED: strictBoolean.default(true),
  DEEPSEEK_REASONING_EFFORT: z.literal("medium").default("medium"),
  DEEPSEEK_BASE_URL: z.url().default("https://api.deepseek.com"),
  DEEPSEEK_INPUT_PRICE_PER_MILLION: price,
  DEEPSEEK_OUTPUT_PRICE_PER_MILLION: price,
});

const telegramSchema = z.object({
  TELEGRAM_BOT_TOKEN: requiredString,
  TELEGRAM_WEBHOOK_SECRET: requiredString,
});

const dashboardSchema = z.object({
  DASHBOARD_SECRET: requiredString,
  SESSION_SIGNING_SECRET: requiredString,
  APP_URL: z.url(),
});

const sandboxSchema = z.object({
  SANDBOX_DRIVE_NAME: requiredString,
  SANDBOX_NAME: requiredString,
  SANDBOX_REGION: z.literal(SANDBOX_REGION).optional(),
  VERCEL_OIDC_TOKEN: requiredString.optional(),
});

export type ModelConfig = z.infer<typeof modelSchema>;
export type TelegramConfig = z.infer<typeof telegramSchema>;
export type DashboardConfig = z.infer<typeof dashboardSchema>;
export type SandboxConfig = z.infer<typeof sandboxSchema> & {
  region: typeof SANDBOX_REGION;
};

export function readModelConfig(
  env: Record<string, string | undefined> = process.env,
): ModelConfig {
  return modelSchema.parse(env);
}

export function readTelegramConfig(
  env: Record<string, string | undefined> = process.env,
): TelegramConfig {
  return telegramSchema.parse(env);
}

export function readDashboardConfig(
  env: Record<string, string | undefined> = process.env,
): DashboardConfig {
  return dashboardSchema.parse(env);
}

export function readSandboxConfig(
  env: Record<string, string | undefined> = process.env,
): SandboxConfig {
  return { ...sandboxSchema.parse(env), region: SANDBOX_REGION };
}
