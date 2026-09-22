import "server-only";
import { secureSecretEqual } from "./secret";
import { validateSession, SESSION_COOKIE } from "./session";
export function isDownloadAuthorized(input: {
  authorization: string | null;
  cookie: string | undefined;
  adminSecret: string;
  signingSecret: string;
}): boolean {
  const header = input.authorization;
  if (header) {
    if (header.includes(",") || !header.startsWith("Bearer ")) return false;
    return secureSecretEqual(
      header.slice(7),
      input.adminSecret,
      input.signingSecret,
    );
  }
  return validateSession(input.cookie, input.signingSecret);
}
export { SESSION_COOKIE };
