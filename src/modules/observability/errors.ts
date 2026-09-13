export const GENERIC_RETRY_MESSAGE =
  'Something went wrong. Please try again later.'

const REDACTIONS: RegExp[] = [
  /bearer\s+[^\s,;]+/gi,
  /(?:postgres(?:ql)?|https?):\/\/[^\s]+/gi,
  /(?:authorization|cookie|set-cookie)\s*[:=]\s*[^\r\n,;]+/gi,
  /(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi,
]

export type ErrorClass =
  'transient' | 'configuration' | 'validation' | 'external' | 'internal'

export interface SafeError {
  errorClass: ErrorClass
  code: string
  safeMessage: string
  retryable: boolean
}

export function redact(value: unknown): string {
  const input = value instanceof Error ? value.message : String(value)
  return REDACTIONS.reduce(
    (text, pattern) => text.replace(pattern, '[REDACTED]'),
    input,
  )
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 500)
}

export function classifyError(error: unknown): SafeError {
  const status =
    typeof error === 'object' &&
    error &&
    'status' in error &&
    typeof error.status === 'number'
      ? error.status
      : undefined
  const code =
    typeof error === 'object' &&
    error &&
    'code' in error &&
    typeof error.code === 'string'
      ? error.code
      : 'unexpected'
  const retryable =
    status === 408 ||
    status === 429 ||
    (status !== undefined && status >= 500) ||
    ['ECONNRESET', 'ETIMEDOUT', '40001', '40P01', '53300', '57P01'].includes(
      code,
    )
  return {
    errorClass: retryable ? 'transient' : 'external',
    code: code.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'unexpected',
    safeMessage: redact(error),
    retryable,
  }
}
