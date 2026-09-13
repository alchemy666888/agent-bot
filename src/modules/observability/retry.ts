import { classifyError } from './errors'

export interface RetryOptions {
  deadline?: number
  now?: () => number
  random?: () => number
  sleep?: (milliseconds: number) => Promise<void>
}

const delays = [250, 1000] as const

export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
) {
  const now = options.now ?? Date.now
  const random = options.random ?? Math.random
  const sleep =
    options.sleep ??
    ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation(attempt)
    } catch (error) {
      if (attempt >= delays.length || !classifyError(error).retryable)
        throw error
      const delay = Math.floor((delays[attempt] ?? 0) * random())
      if (options.deadline !== undefined && now() + delay >= options.deadline)
        throw error
      await sleep(delay)
    }
  }
}
