import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
const digest = (value: string, key: string) =>
  createHmac("sha256", key).update(value).digest();
export function secureSecretEqual(
  candidate: string,
  expected: string,
  key: string,
): boolean {
  if (!candidate || !expected || !key) return false;
  return timingSafeEqual(digest(candidate, key), digest(expected, key));
}
