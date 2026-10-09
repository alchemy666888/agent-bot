const TELEGRAM_USERNAME = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;
const TELEGRAM_NUMERIC_ID = /^[1-9][0-9]*$/;

export interface TelegramAllowlist {
  ids: Set<string>;
  usernames: Set<string>;
}

/** Classifies one allowlist token. Usernames are stored without "@" and lowercased. */
export function classifyTelegramAllowlistToken(
  token: string,
): { kind: "id" | "username"; value: string } | { kind: "invalid" } {
  const bare = token.startsWith("@") ? token.slice(1) : token;
  if (TELEGRAM_USERNAME.test(bare))
    return { kind: "username", value: bare.toLowerCase() };
  if (!TELEGRAM_NUMERIC_ID.test(bare)) return { kind: "invalid" };
  if (BigInt(bare) > BigInt(Number.MAX_SAFE_INTEGER))
    return { kind: "invalid" };
  return { kind: "id", value: bare };
}

/**
 * Keeps numeric Telegram IDs and public usernames. Unrecognized tokens are
 * ignored so one malformed entry cannot erase the rest of the allowlist.
 */
export function parseTelegramAllowlist(
  value: string | undefined,
): TelegramAllowlist {
  const ids = new Set<string>();
  const usernames = new Set<string>();
  for (const raw of (value ?? "").split(",")) {
    const token = raw.trim();
    if (!token) continue;
    const classified = classifyTelegramAllowlistToken(token);
    if (classified.kind === "id") ids.add(classified.value);
    if (classified.kind === "username") usernames.add(classified.value);
  }
  return { ids, usernames };
}

/** Empty input is an empty allowlist. Invalid or repeated entries fail closed. */
export function parseStrictTelegramAllowlist(
  value: string,
):
  | { ok: true; allowlist: TelegramAllowlist }
  | { ok: false; reason: "invalid" | "duplicate" } {
  const ids = new Set<string>();
  const usernames = new Set<string>();
  for (const raw of value.split(",")) {
    const token = raw.trim();
    if (!token) continue;
    const classified = classifyTelegramAllowlistToken(token);
    if (classified.kind === "invalid") return { ok: false, reason: "invalid" };
    const bucket = classified.kind === "id" ? ids : usernames;
    if (bucket.has(classified.value)) return { ok: false, reason: "duplicate" };
    bucket.add(classified.value);
  }
  return { ok: true, allowlist: { ids, usernames } };
}

export function isTelegramActorAllowed(
  allowlist: { ids: ReadonlySet<string>; usernames?: ReadonlySet<string> },
  userId: string,
  username?: string,
): boolean {
  if (allowlist.ids.has(userId)) return true;
  if (!username) return false;
  const classified = classifyTelegramAllowlistToken(username.trim());
  return (
    classified.kind === "username" &&
    Boolean(allowlist.usernames?.has(classified.value))
  );
}
