import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
export const SESSION_COOKIE = "__Host-telegram-agent-session";
export const SESSION_SECONDS = 86400;
const encode = (value: string) => Buffer.from(value).toString("base64url");
export function createSession(secret: string, now = Date.now()): string {
  const payload = encode(
    JSON.stringify({ expiresAt: now + SESSION_SECONDS * 1000 }),
  );
  const signature = createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}
export function validateSession(
  value: string | undefined,
  secret: string,
  now = Date.now(),
): boolean {
  if (!value || !secret) return false;
  const parts = value.split(".");
  if (parts.length !== 2) return false;
  const expected = createHmac("sha256", secret).update(parts[0]!).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(parts[1]!, "base64url");
  } catch {
    return false;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    return false;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[0]!, "base64url").toString(),
    ) as { expiresAt?: number };
    return typeof payload.expiresAt === "number" && payload.expiresAt > now;
  } catch {
    return false;
  }
}
export const sessionCookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: "strict" as const,
  path: "/",
  maxAge: SESSION_SECONDS,
};
