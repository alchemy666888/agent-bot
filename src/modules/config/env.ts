import { z } from 'zod'

const nonEmpty = z.string().trim().min(1)

export const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful, accurate, and safe general-purpose assistant. Answer in the language of the user's latest message unless they request another language."

type Environment = Record<string, string | undefined>

function parse<T>(schema: z.ZodType<T>, env: Environment): T {
  const result = schema.safeParse(env)
  if (!result.success) throw new Error('Invalid server configuration')
  return result.data
}

export function parseDatabaseConfig(env: Environment) {
  return parse(
    z.object({
      DATABASE_URL: nonEmpty,
      DATABASE_POOL_MAX: z.coerce
        .number()
        .int()
        .positive()
        .max(100)
        .default(10),
    }),
    env,
  )
}

export function parseTelegramConfig(env: Environment) {
  return parse(
    z.object({
      TELEGRAM_BOT_TOKEN: nonEmpty,
      TELEGRAM_WEBHOOK_SECRET: nonEmpty,
    }),
    env,
  )
}

const price = z.string().regex(/^\d+(?:\.\d+)?$/)

export function parseDeepSeekConfig(env: Environment) {
  return parse(
    z.object({
      DEEPSEEK_API_KEY: nonEmpty,
      DEEPSEEK_BASE_URL: z.url().default('https://api.deepseek.com'),
      DEEPSEEK_THINKING_ENABLED: z
        .enum(['true', 'false'])
        .catch('true')
        .transform((value) => value === 'true'),
      DEEPSEEK_REASONING_EFFORT: z
        .enum(['low', 'medium', 'high', 'max'])
        .default('medium'),
      ASSISTANT_SYSTEM_PROMPT: nonEmpty.default(DEFAULT_SYSTEM_PROMPT),
      DEEPSEEK_INPUT_PRICE_PER_MILLION: price,
      DEEPSEEK_OUTPUT_PRICE_PER_MILLION: price,
    }),
    env,
  )
}

export function parseAuthConfig(env: Environment) {
  return parse(
    z.object({ DASHBOARD_SECRET: nonEmpty, SESSION_SIGNING_SECRET: nonEmpty }),
    env,
  )
}

export function parseOperatorConfig(env: Environment) {
  return parse(
    z.object({
      APP_URL: z.url().refine((url) => url.startsWith('https://')),
      TELEGRAM_BOT_TOKEN: nonEmpty,
      TELEGRAM_WEBHOOK_SECRET: nonEmpty,
    }),
    env,
  )
}
