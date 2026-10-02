import { describe, expect, it } from "vitest";
import { readPromptConfig } from "../../../../src/server/config";
import { promptRolloutPolicy } from "../../../../src/server/prompts/rollout";

describe("prompt rollout policy", () => {
  it("allocates the same opaque user key deterministically", () => {
    const config = readPromptConfig({
      PROMPT_READS_ENABLED: "true",
      PROMPT_AUTONOMOUS_SUGGESTIONS_ENABLED: "true",
      PROMPT_SUGGESTION_COHORT_PERCENT: "10",
      GITHUB_CONNECTOR: "github/prompts",
      GITHUB_PROMPTS_OWNER: "owner",
      GITHUB_PROMPTS_REPO: "private-prompts",
      GITHUB_PROMPTS_BRANCH: "main",
      GITHUB_PROMPTS_PREFIX: "prompts",
      PROMPT_OPERATOR_TELEGRAM_IDS: "123",
      PROMPT_USER_KEY_SECRET: "abcdefgh-abcdefgh-abcdefgh-abcdefgh",
    });
    const key = `u1_${"A".repeat(43)}`;
    expect(promptRolloutPolicy(config, key)).toEqual(
      promptRolloutPolicy(config, key),
    );
    expect(promptRolloutPolicy(config, key).cohortBucket).toBeLessThan(100);
  });
});
