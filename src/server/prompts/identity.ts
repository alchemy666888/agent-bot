import "server-only";

import { createHmac } from "node:crypto";

const TELEGRAM_USER_ID = /^[1-9][0-9]{0,19}$/;
const MIN_SECRET_BYTES = 32;

/**
 * Produces the only form of user identity which may be placed in the prompt
 * repository. Neither argument is retained or logged by this function.
 */
export function derivePromptUserKey(
  secret: string | Uint8Array,
  telegramUserId: string | number | bigint,
): string {
  const id = String(telegramUserId);
  const secretBytes =
    typeof secret === "string" ? Buffer.from(secret, "utf8") : secret;
  if (secretBytes.byteLength < MIN_SECRET_BYTES)
    throw new TypeError("Prompt user-key secret must be at least 32 bytes");
  if (!TELEGRAM_USER_ID.test(id))
    throw new TypeError("Invalid Telegram user ID");

  return `u1_${createHmac("sha256", secretBytes).update(id, "ascii").digest("base64url")}`;
}

export const PROMPT_USER_KEY_PATTERN = /^u1_[A-Za-z0-9_-]{43}$/;
