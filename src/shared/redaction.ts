const forbiddenKey =
  /authorization|cookie|token|secret|password|api.?key|reasoning|stack|(?:raw|tool).?(body|update|response|output)/i;
const secretText = /(bearer\s+\S+|(?:sk|bot|oidc)[-_][A-Za-z0-9._-]{6,})/gi;

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
