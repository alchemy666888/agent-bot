import {
  promptBundleSchema,
  type PromptBundle,
} from "../../shared/contracts/prompt";

/** Parse and detach a bundle at the worker boundary.  The detached object is
 * pinned for the lifetime of a turn and cannot be changed by caller code. */
export function parsePromptBundle(value: unknown): Readonly<PromptBundle> {
  const parsed = promptBundleSchema.parse(value);
  return deepFreeze(structuredClone(parsed));
}

export function compiledEmergencyBundle(
  commonSystemPrompt: string,
): Readonly<PromptBundle> {
  return parsePromptBundle({
    schemaVersion: 1,
    runtimePolicy: { version: "1", mode: "emergency" },
    commonSystemPrompt: {
      id: "compiled-emergency-system",
      content: commonSystemPrompt,
      source: "compiled_emergency",
    },
    requestTemplate: {
      id: "compiled-emergency-request",
      content: "Answer the current request safely and directly.",
      source: "compiled_emergency",
    },
    trustedRuntimeContext: [],
    repositoryCommitSha: null,
    selectedBlobShas: [],
    resolutionSource: "emergency",
    degradedModeSource: "compiled_emergency",
    turnPin: { commitSha: null, pinnedAt: new Date(0).toISOString() },
    telemetry: { resolution: "fallback", degraded: true },
  });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>))
      deepFreeze(child);
  }
  return value;
}
