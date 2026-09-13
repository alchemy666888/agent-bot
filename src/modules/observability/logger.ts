import 'server-only'

import { redact } from './errors'

type LogLevel = 'info' | 'warn' | 'error'
type Context = Record<string, string | number | boolean | null | undefined>

export function log(level: LogLevel, event: string, context: Context = {}) {
  const safeContext = Object.fromEntries(
    Object.entries(context)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [
        key,
        typeof value === 'string' ? redact(value) : value,
      ]),
  )
  process.stdout.write(`${JSON.stringify({ level, event, ...safeContext })}\n`)
}
