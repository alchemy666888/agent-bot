import { describe, expect, it } from "vitest";
import type { VerifiedPromptSnapshot } from "../../../src/server/prompts/github-store";
import { resolvePrompt } from "../../../src/server/prompts/resolver";

describe("prompt router catalog boundary", () => {
  it("exposes authorized metadata but not paths, bodies, identities, or inactive IDs", async () => {
    const userKey = `u1_${"A".repeat(43)}`;
    const make = (id: string, status: "active" | "disabled") => ({
      path: `prompts/global/requests/${id}.md`,
      body: `secret body for ${id}`,
      blobSha: "b".repeat(40),
      metadata: {
        schemaVersion: 1 as const,
        id,
        kind: "request" as const,
        scope: "global" as const,
        status,
        summary: `${id} summary`,
        triggers: { commands: [] as string[], phrases: [] as string[] },
        languages: ["*"],
      },
    });
    const snapshot: VerifiedPromptSnapshot = {
      commitSha: "a".repeat(40),
      contentDigest: "digest",
      validatedAt: new Date().toISOString(),
      files: [
        {
          ...make("default", "active"),
          path: "prompts/common/requests/default.md",
          metadata: { ...make("default", "active").metadata, scope: "common" },
        },
        make("research", "active"),
        make("disabled", "disabled"),
      ],
    };
    let serialized = "";
    await resolvePrompt({
      snapshot,
      userKey,
      text: "unmatched",
      routerEnabled: true,
      router: async (request) => {
        serialized = JSON.stringify(request);
        return {
          requestId: request.requestId,
          selectedId: null,
          confidence: 0,
          reasonCode: "no_match",
        };
      },
    });
    expect(serialized).toContain("research");
    expect(serialized).not.toContain("disabled");
    expect(serialized).not.toContain("secret body");
    expect(serialized).not.toContain("prompts/");
    expect(serialized).not.toContain(userKey);
  });
});
