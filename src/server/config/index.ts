import "server-only";

import { z } from "zod";

export { readDatabaseConfig } from "../../shared/postgres/config";

export const SANDBOX_REGION = "sin1" as const;
export const DEFAULT_EMERGENCY_SYSTEM_PROMPT =
  "You are a helpful, accurate, and safe general-purpose assistant. Reply in the language of the user's latest message unless they request another language.";
/** @deprecated Use DEFAULT_EMERGENCY_SYSTEM_PROMPT. */
export const DEFAULT_SYSTEM_PROMPT = DEFAULT_EMERGENCY_SYSTEM_PROMPT;

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
  // This is a break-glass fallback, not normal hierarchy-managed prompt content.
  ASSISTANT_SYSTEM_PROMPT: requiredString.default(
    DEFAULT_EMERGENCY_SYSTEM_PROMPT,
  ),
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

const optionalEnv = (schema: z.ZodType) =>
  z.preprocess(
    (value) => (value === "" || value === undefined ? undefined : value),
    schema.optional(),
  );

const promptPrefix = z
  .string()
  .max(1024)
  .refine(
    (value) => value === value.trim(),
    "Prefix must not contain outer whitespace",
  )
  .refine(
    (value) =>
      value === "prompts" ||
      (value.startsWith("prompts/") &&
        value
          .split("/")
          .every(
            (segment) => segment !== "" && segment !== "." && segment !== "..",
          )),
    "Prefix must be prompts or a normalized descendant of prompts",
  );

const telegramOperatorIds = z
  .string()
  .transform((value, context): ReadonlySet<string> => {
    const tokens = value.split(",");
    const ids = new Set<string>();

    for (const token of tokens) {
      if (!/^[1-9][0-9]*$/.test(token)) {
        context.addIssue({
          code: "custom",
          message:
            "Operator IDs must be comma-separated canonical positive Telegram numeric strings",
        });
        return z.NEVER;
      }
      if (BigInt(token) > BigInt(Number.MAX_SAFE_INTEGER)) {
        context.addIssue({
          code: "custom",
          message: "Operator ID exceeds the safe Telegram numeric range",
        });
        return z.NEVER;
      }
      if (ids.has(token)) {
        context.addIssue({ code: "custom", message: "Duplicate operator ID" });
        return z.NEVER;
      }
      ids.add(token);
    }

    return ids;
  });

const promptConfigSchema = z
  .object({
    PROMPT_HIERARCHY_ENABLED: strictBoolean.default(false),
    PROMPT_HIERARCHY_WRITES_ENABLED: strictBoolean.default(false),
    GITHUB_CONNECTOR: optionalEnv(
      z
        .string()
        .trim()
        .regex(/^github\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/),
    ),
    GITHUB_PROMPTS_OWNER: optionalEnv(githubName),
    GITHUB_PROMPTS_REPO: optionalEnv(githubName),
    GITHUB_PROMPTS_BRANCH: optionalEnv(gitBranch),
    GITHUB_PROMPTS_PREFIX: optionalEnv(promptPrefix),
    PROMPT_OPERATOR_TELEGRAM_IDS: optionalEnv(telegramOperatorIds),
    PROMPT_USER_KEY_SECRET: optionalEnv(
      z
        .string()
        .min(32)
        .max(1024)
        .refine(
          (value) => new Set(value).size >= 8,
          "User-key secret must contain at least eight distinct characters",
        ),
    ),
    PROMPT_CACHE_TTL_SECONDS: optionalEnv(
      z.coerce.number().int().min(1).max(86_400),
    ).default(300),
    PROMPT_CONFIRMATION_TTL_SECONDS: optionalEnv(
      z.coerce.number().int().min(30).max(3_600),
    ).default(600),
    PROMPT_ROUTER_CONFIDENCE_THRESHOLD: optionalEnv(
      z.coerce.number().min(0).max(1),
    ).default(0.75),
  })
  .superRefine((config, context) => {
    if (!config.PROMPT_HIERARCHY_ENABLED) {
      if (config.PROMPT_HIERARCHY_WRITES_ENABLED) {
        context.addIssue({
          code: "custom",
          path: ["PROMPT_HIERARCHY_WRITES_ENABLED"],
          message: "Prompt writes require the prompt hierarchy",
        });
      }
      return;
    }

    for (const key of [
      "GITHUB_CONNECTOR",
      "GITHUB_PROMPTS_OWNER",
      "GITHUB_PROMPTS_REPO",
      "GITHUB_PROMPTS_BRANCH",
      "GITHUB_PROMPTS_PREFIX",
      "PROMPT_OPERATOR_TELEGRAM_IDS",
      "PROMPT_USER_KEY_SECRET",
    ] as const) {
      if (config[key] === undefined) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: `${key} is required when the prompt hierarchy is enabled`,
        });
      }
    }

    if (
      config.PROMPT_HIERARCHY_WRITES_ENABLED &&
      config.GITHUB_PROMPTS_BRANCH !== "main"
    ) {
      context.addIssue({
        code: "custom",
        path: ["GITHUB_PROMPTS_BRANCH"],
        message: "Write-enabled prompt deployments must use the main branch",
      });
    }
  });

export type ModelConfig = z.infer<typeof modelSchema>;
export type TelegramConfig = z.infer<typeof telegramSchema>;
export type DashboardConfig = z.infer<typeof dashboardSchema>;
export type SandboxConfig = z.infer<typeof sandboxSchema> & {
  region: typeof SANDBOX_REGION;
};
export type GitHubConfig = z.output<typeof githubSchema>;
export type PromptConfig = z.output<typeof promptConfigSchema>;

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

/** Prompt repository policy and secrets. Keep this result in the trusted server process. */
export function readPromptConfig(
  env: Record<string, string | undefined> = process.env,
): PromptConfig {
  return promptConfigSchema.parse(env);
}
