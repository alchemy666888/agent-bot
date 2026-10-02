const forbiddenKey =
  /authorization|cookie|token|secret|password|api.?key|reasoning|stack|prompt|instructions|skill(content|document)|tool(output|result)|raw(body|update|response)/i;
const secretText =
  /(bearer\s+\S+|(?:sk|bot|oidc|ghp|xox[baprs])[-_][A-Za-z0-9._-]{6,}|(?:password|secret|api[_-]?key)\s*[:=]\s*\S+)/gi;

const likelySecretText =
  /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bAKIA[A-Z0-9]{16}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b|\b(?:gh[opusr]|xox[baprs])_[A-Za-z0-9_-]{20,}|\bsk-[A-Za-z0-9_-]{20,}|\b(?:bearer|password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*[^\s]{6,})/i;
const sensitivePreference =
  /\b(?:health|medical|diagnos(?:is|ed)|disabilit(?:y|ies)|politic(?:al|s)|party affiliation|religion|religious|faith|sexual orientation|gender identity|race|ethnicity|biometric|genetic|bank|credit|debt|income|salary|financial|password|credential|api key|token)\b/i;
const persistenceLanguage =
  /\b(?:remember|save|store|persist|from now on|always|preference|profile|in future|以后|記住|记住|永久)\b/i;

/** Heuristic defense in depth, not a complete secret scanner. */
export function containsLikelySecret(value: string): boolean {
  return likelySecretText.test(value);
}

/**
 * Server-side gate for both model proposals and natural-language management
 * commands. Unknown/advisory classifications default to no persistence.
 */
export function mayPersistPreference(input: {
  text: string;
  explicitlyPersistent?: boolean;
  inferred?: boolean;
  modelClassification?: "persistent" | "one_time" | "sensitive" | "uncertain";
}): boolean {
  if (input.inferred === true) return false;
  if (sensitivePreference.test(input.text) || containsLikelySecret(input.text))
    return false;
  if (input.modelClassification && input.modelClassification !== "persistent")
    return false;
  return (
    input.explicitlyPersistent === true || persistenceLanguage.test(input.text)
  );
}

export const isSafePersistentPreference = mayPersistPreference;

export function isSensitivePreference(value: string): boolean {
  return sensitivePreference.test(value) || containsLikelySecret(value);
}

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
