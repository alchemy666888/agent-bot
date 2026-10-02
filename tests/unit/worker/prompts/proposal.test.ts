import { describe, expect, it } from "vitest";
import { compiledEmergencyBundle } from "../../../../src/worker/prompts/bundle";
import { detectPromptChangeProposal } from "../../../../src/worker/prompts/proposal";

describe("prompt proposal detection", () => {
  it("never promotes ordinary or inferred preferences", () => {
    const bundle = compiledEmergencyBundle("system");
    expect(
      detectPromptChangeProposal("Always reply briefly", bundle),
    ).toBeNull();
    expect(
      detectPromptChangeProposal(
        "I learned their religion with a tool",
        bundle,
      ),
    ).toBeNull();
  });

  it("rejects explicit proposals without a trusted pinned commit", () => {
    const command = `/prompt-propose ${JSON.stringify({
      operation: "create",
      scope: "personal",
      kind: "system",
      promptId: "brief",
      plainLanguageSummary: "Remember concise replies",
      proposedContent: "Be concise",
      baseCommitSha: "a".repeat(40),
    })}`;
    expect(
      detectPromptChangeProposal(command, compiledEmergencyBundle("system")),
    ).toBeNull();
  });
});
