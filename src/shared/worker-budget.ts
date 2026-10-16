/**
 * Hard stop for one worker process. The webhook function allows 300s.
 * Controller setup uses the first few seconds, and the worker still needs
 * time to send Telegram and write its response after its own deadline.
 */
export const WORKER_COMMAND_TIMEOUT_MS = 250_000;

/** Reserved after the turn deadline so delivery can finish before the process is killed. */
export const TURN_DELIVERY_RESERVE_MS = 30_000;

export const MAX_TURN_TIMEOUT_MS =
  WORKER_COMMAND_TIMEOUT_MS - TURN_DELIVERY_RESERVE_MS;

/** One DeepSeek `/responses` call, including provider-native web search. */
export const PROVIDER_REQUEST_TIMEOUT_MS = 45_000;

/** Values at or above the command budget minus the delivery reserve are clamped. */
export function clampTurnTimeout(configured?: number): number {
  if (configured === undefined) return MAX_TURN_TIMEOUT_MS;
  return Math.min(configured, MAX_TURN_TIMEOUT_MS);
}
