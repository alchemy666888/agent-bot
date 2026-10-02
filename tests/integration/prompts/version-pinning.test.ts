import { describe, expect, it } from "vitest";
import type { VerifiedPromptSnapshot } from "../../../src/server/prompts/github-store";
import { PromptService } from "../../../src/server/prompts/service";

const commit = "a".repeat(40);
const userKey = `u1_${"A".repeat(43)}`;

function snapshot(): VerifiedPromptSnapshot {
  const make = (
    path: string,
    id: string,
    kind: "system" | "request",
    scope: "common" | "personal",
    digit: string,
  ) => ({
    path,
    body: `${id} content`,
    blobSha: digit.repeat(40),
    metadata: {
      schemaVersion: 1 as const,
      id,
      kind,
      scope,
      status: "active" as const,
      summary: id,
      triggers: { commands: [] as string[], phrases: [] as string[] },
      languages: ["*"],
    },
  });
  return {
    commitSha: commit,
    contentDigest: "digest",
    validatedAt: new Date().toISOString(),
    files: [
      make("prompts/common/system/base.md", "base", "system", "common", "b"),
      make(
        "prompts/common/requests/default.md",
        "default",
        "request",
        "common",
        "c",
      ),
      make(
        `prompts/users/${userKey}/system/preferences.md`,
        "preferences",
        "system",
        "personal",
        "d",
      ),
    ],
  };
}

describe("prompt turn version pinning", () => {
  it("freezes a complete bundle from exactly one verified commit", async () => {
    const original = snapshot();
    const service = new PromptService(
      {
        get: async () => ({
          source: "current_snapshot" as const,
          snapshot: original,
        }),
      },
      { now: () => new Date("2026-10-02T00:00:00.000Z") },
    );
    const bundle = await service.resolve({ userKey, text: "hello" });
    original.commitSha = "e".repeat(40); // simulates a cache refresh after resolution

    expect(bundle.repositoryCommitSha).toBe(commit);
    expect(bundle.turnPin.commitSha).toBe(commit);
    expect(bundle.commonSystemPrompt.id).toBe("base");
    expect(bundle.personalOverlay?.id).toBe("preferences");
    expect(bundle.requestTemplate.id).toBe("default");
    expect(Object.isFrozen(bundle)).toBe(true);
    expect(Object.isFrozen(bundle.requestTemplate)).toBe(true);
  });
});
