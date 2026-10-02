import "server-only";

import { createHash } from "node:crypto";
import type { PromptConfig } from "../config";

/** Safe policy decisions made only from an already-opaque user key. */
export function promptRolloutPolicy(config: PromptConfig, userKey: string) {
  const bucket =
    createHash("sha256").update(userKey).digest().readUInt32BE(0) % 100;
  return Object.freeze({
    reads: config.PROMPT_READS_ENABLED,
    personalReads:
      config.PROMPT_READS_ENABLED && config.PROMPT_PERSONAL_READS_ENABLED,
    operatorWrites:
      config.PROMPT_READS_ENABLED && config.PROMPT_OPERATOR_WRITES_ENABLED,
    personalWrites:
      config.PROMPT_READS_ENABLED && config.PROMPT_PERSONAL_WRITES_ENABLED,
    router: config.PROMPT_READS_ENABLED && config.PROMPT_ROUTER_ENABLED,
    autonomousSuggestions:
      config.PROMPT_READS_ENABLED &&
      config.PROMPT_AUTONOMOUS_SUGGESTIONS_ENABLED &&
      bucket < config.PROMPT_SUGGESTION_COHORT_PERCENT,
    cohortBucket: bucket,
  });
}
