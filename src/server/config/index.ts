import "server-only";

import { z } from "zod";

export { readDatabaseConfig } from "../../shared/postgres/config";

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
const boundedRouterTimeout = z.coerce.number().int().min(250).max(30_000);
const optionalConfidence = z.preprocess(
  (value) => (value === "" || value === undefined ? undefined : value),
  z.coerce.number().min(0).max(1).optional(),
);

const modelSchema = z.object({
  DEEPSEEK_API_KEY: requiredString,
  ASSISTANT_SYSTEM_PROMPT: requiredString.default(DEFAULT_SYSTEM_PROMPT),
  DEEPSEEK_THINKING_ENABLED: strictBoolean.default(true),
  DEEPSEEK_REASONING_EFFORT: z.literal("medium").default("medium"),
  DEEPSEEK_BASE_URL: z.url().default("https://api.deepseek.com"),
  DEEPSEEK_ROUTING_ENABLED: strictBoolean.default(false),
  DEEPSEEK_ROUTING_MODE: z.enum(["shadow", "enforced"]).default("shadow"),
  DEEPSEEK_ROUTER_TIMEOUT_MS: boundedRouterTimeout.default(3_000),
  DEEPSEEK_ROUTER_MIN_CONFIDENCE: optionalConfidence,
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
  SANDBOX_NAME: requiredString,
  SANDBOX_REGION: z.literal(SANDBOX_REGION).optional(),
  VERCEL_OIDC_TOKEN: requiredString.optional(),
});

const githubName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/);
const gitBranch = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      !value.startsWith("-") &&
      !value.startsWith("/") &&
      !value.endsWith("/") &&
      !value.endsWith(".") &&
      !value.includes("..") &&
      !value.includes("//") &&
      !/[~^:?*[\\\]\s]/.test(value) &&
      !value.includes("@{") &&
      !value.endsWith(".lock"),
    "Invalid Git branch name",
  );
const repositoryPrefix = z
  .string()
  .trim()
  .max(1024)
  .refine(
    (value) =>
      value === "" ||
      (!value.startsWith("/") &&
        !value.endsWith("/") &&
        value
          .split("/")
          .every(
            (segment) => segment !== "" && segment !== "." && segment !== "..",
          )),
    "Prefix must be a normalized repository-relative path",
  )
  .optional()
  .transform((value) => value || undefined);

const githubSchema = z.object({
  GITHUB_CONNECTOR: z
    .string()
    .trim()
    .regex(/^github\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/),
  GITHUB_SKILLS_OWNER: githubName,
  GITHUB_SKILLS_REPO: githubName,
  GITHUB_SKILLS_BRANCH: gitBranch,
  GITHUB_SKILLS_PREFIX: repositoryPrefix,
});

export type ModelConfig = z.infer<typeof modelSchema>;
export type TelegramConfig = z.infer<typeof telegramSchema>;
export type DashboardConfig = z.infer<typeof dashboardSchema>;
export type SandboxConfig = z.infer<typeof sandboxSchema> & {
  region: typeof SANDBOX_REGION;
};
export type GitHubConfig = z.output<typeof githubSchema>;

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

/** Server-only GitHub Connect settings; this module must never be imported by a client component. */
export function readGitHubConfig(
  env: Record<string, string | undefined> = process.env,
): GitHubConfig {
  return githubSchema.parse(env);
}
