const forbiddenKey =
  /authorization|cookie|token|secret|password|api.?key|reasoning|stack|prompt|instructions|skill(content|document)|tool(output|result)|raw(body|update|response)/i;
const secretText =
  /(bearer\s+\S+|(?:sk|bot|oidc|ghp|xox[baprs])[-_][A-Za-z0-9._-]{6,}|(?:password|secret|api[_-]?key)\s*[:=]\s*\S+)/gi;

export function redact(value: unknown): unknown {
  if (typeof value === "string")
    return value.replace(secretText, "[REDACTED]").slice(0, 1024);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !forbiddenKey.test(key))
        .map(([key, item]) => [key, redact(item)]),
    );
  return value;
}
