import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SYSTEM_PROMPT,
  parseDatabaseConfig,
  parseDeepSeekConfig,
} from '../../src/modules/config/env'
import { classifyError, redact } from '../../src/modules/observability/errors'
import { withRetry } from '../../src/modules/observability/retry'

const modelEnv = {
  DEEPSEEK_API_KEY: 'test-key',
  DEEPSEEK_INPUT_PRICE_PER_MILLION: '1.25',
  DEEPSEEK_OUTPUT_PRICE_PER_MILLION: '2.5',
}

describe('configuration', () => {
  it('applies approved defaults and fail-closes missing values', () => {
    expect(parseDeepSeekConfig(modelEnv)).toMatchObject({
      ASSISTANT_SYSTEM_PROMPT: DEFAULT_SYSTEM_PROMPT,
      DEEPSEEK_THINKING_ENABLED: true,
      DEEPSEEK_REASONING_EFFORT: 'medium',
      DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
    })
    expect(() => parseDatabaseConfig({})).toThrow(
      'Invalid server configuration',
    )
  })

  it('defaults invalid thinking configuration to enabled', () => {
    expect(
      parseDeepSeekConfig({ ...modelEnv, DEEPSEEK_THINKING_ENABLED: 'invalid' })
        .DEEPSEEK_THINKING_ENABLED,
    ).toBe(true)
  })
})

describe('observability', () => {
  it('redacts prohibited secret categories', () => {
    const safe = redact(
      'Bearer seeded-token DATABASE_URL=postgres://person:pass@host/db cookie=session-value password=hunter2',
    )
    expect(safe).not.toMatch(/seeded-token|person:pass|session-value|hunter2/)
  })

  it('classifies transient statuses and database errors', () => {
    expect(classifyError({ status: 429 }).retryable).toBe(true)
    expect(classifyError({ code: '40P01' }).retryable).toBe(true)
    expect(classifyError({ status: 400 }).retryable).toBe(false)
  })

  it('never performs more than two retries', async () => {
    const operation = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
      )
    const sleep = vi.fn().mockResolvedValue(undefined)
    await expect(
      withRetry(operation, { random: () => 0, sleep }),
    ).rejects.toThrow('timeout')
    expect(operation).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
  })
})
