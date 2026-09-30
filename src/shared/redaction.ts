const forbiddenKey =
  /authorization|cookie|set-cookie|token|secret|password|passphrase|api.?key|private.?key|session|reasoning|stack|raw(body|update|response)|prompt/i;
const secretText =
  /(bearer\s+\S+|(?:sk|bot|oidc|ghp|github_pat|xox[baprs])[-_:][A-Za-z0-9._-]{6,}|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----)/gi;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED]";
  if (typeof value === "string")
    return value.replace(secretText, "[REDACTED]").slice(0, 1024);
  if (Array.isArray(value))
    return value.slice(0, 100).map((item) => redact(item, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !forbiddenKey.test(key))
        .slice(0, 100)
        .map(([key, item]) => [key, redact(item, depth + 1)]),
    );
  return value;
}
