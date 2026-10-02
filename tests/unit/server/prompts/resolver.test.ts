import { describe, expect, it, vi } from "vitest";
import type { VerifiedPromptSnapshot } from "../../../../src/server/prompts/github-store";
import {
  authorizedRequestPrompts,
  parseExplicitPromptSelection,
  resolvePrompt,
} from "../../../../src/server/prompts/resolver";

const sha = "a".repeat(40);
const userKey = `u1_${"A".repeat(43)}`;

function file(
  id: string,
  scope: "common" | "global" | "personal",
  options: {
    commands?: string[];
    phrases?: string[];
    status?: "active" | "disabled";
  } = {},
) {
  const owner = scope === "personal" ? `users/${userKey}` : scope;
  return {
    path: `prompts/${owner}/requests/${id}.md`,
    body: `body:${id}`,
    blobSha: id.padEnd(40, "b").slice(0, 40),
    metadata: {
      schemaVersion: 1 as const,
      id,
      kind: "request" as const,
      scope,
      status: options.status ?? ("active" as const),
      summary: id,
      triggers: {
        commands: options.commands ?? [],
        phrases: options.phrases ?? [],
      },
      languages: ["*"] as string[],
    },
  };
}

function snapshot(files = [file("default", "common")]): VerifiedPromptSnapshot {
  return {
    commitSha: sha,
    files,
    contentDigest: "digest",
    validatedAt: new Date().toISOString(),
  };
}

describe("prompt resolver", () => {
  it("reserves one exact explicit syntax and filters authorization first", async () => {
    expect(parseExplicitPromptSelection("/prompt research")).toBe("research");
    expect(parseExplicitPromptSelection("please /prompt research")).toBeNull();
    const other = file("private", "personal");
    other.path = `prompts/users/u1_${"B".repeat(43)}/requests/private.md`;
    const files = [
      file("default", "common"),
      file("research", "global"),
      other,
    ];
    expect(
      authorizedRequestPrompts(snapshot(files), userKey).map(
        (item) => item.metadata.id,
      ),
    ).toEqual(["default", "research"]);
    await expect(
      resolvePrompt({
        snapshot: snapshot(files),
        userKey,
        text: "/prompt private",
      }),
    ).resolves.toMatchObject({
      file: { metadata: { id: "default" } },
      source: "default",
    });
  });

  it("uses unique bounded triggers and treats equally ranked matches as ambiguous", async () => {
    const files = [
      file("default", "common"),
      file("one", "global", { phrases: ["daily report"] }),
      file("two", "global", { phrases: ["daily report"] }),
    ];
    const router = vi.fn();
    const result = await resolvePrompt({
      snapshot: snapshot(files),
      userKey,
      text: "Create a daily report, please",
      router,
      routerEnabled: false,
    });
    expect(result.file.metadata.id).toBe("default");
    expect(router).not.toHaveBeenCalled();
  });

  it("rejects invented and low-confidence router IDs", async () => {
    const files = [file("default", "common"), file("research", "global")];
    for (const selectedId of ["invented", "research"]) {
      const result = await resolvePrompt({
        snapshot: snapshot(files),
        userKey,
        text: "investigate this",
        routerEnabled: true,
        confidenceThreshold: 0.75,
        requestId: "019a3c57-b3bd-7000-8000-000000000000",
        router: async (request) => ({
          requestId: request.requestId,
          selectedId,
          confidence: selectedId === "research" ? 0.74 : 1,
          reasonCode: "selected",
        }),
      });
      expect(result.file.metadata.id).toBe("default");
    }
  });
});
