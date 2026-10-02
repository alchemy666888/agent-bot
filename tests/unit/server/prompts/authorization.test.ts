import { describe, expect, it } from "vitest";
import {
  authorizePrompt,
  isPromptAuthorized,
  listAuthorizedPromptSummaries,
} from "../../../../src/server/prompts/authorization";

const alice = { canonicalId: "100", userKey: `u1_${"A".repeat(43)}` };
const bobKey = `u1_${"B".repeat(43)}`;

describe("prompt authorization", () => {
  it("allows shared reads and only same-namespace personal access", () => {
    expect(
      isPromptAuthorized({
        actor: alice,
        target: { scope: "global" },
        action: "read",
      }),
    ).toBe(true);
    expect(
      isPromptAuthorized({
        actor: alice,
        target: { scope: "personal", userKey: alice.userKey },
        action: "update",
      }),
    ).toBe(true);
    expect(
      isPromptAuthorized({
        actor: alice,
        target: { scope: "personal", userKey: bobKey },
        action: "read",
      }),
    ).toBe(false);
  });

  it("requires the server allowlist for common/global mutation", () => {
    const input = {
      actor: alice,
      target: { scope: "common" } as const,
      action: "update" as const,
    };
    expect(isPromptAuthorized(input)).toBe(false);
    expect(
      isPromptAuthorized({ ...input, operatorIds: new Set(["100"]) }),
    ).toBe(true);
  });

  it("uses the same response for missing and cross-user resources", () => {
    expect(() =>
      authorizePrompt({
        actor: alice,
        target: { scope: "personal", userKey: bobKey },
        action: "read",
      }),
    ).toThrow("PROMPT_NOT_FOUND");
    expect(
      listAuthorizedPromptSummaries(alice, [
        {
          id: "mine",
          kind: "system",
          scope: "personal",
          summary: "Concise replies",
          userKey: alice.userKey,
          body: "private",
          path: "private",
        },
        {
          id: "theirs",
          kind: "system",
          scope: "personal",
          summary: "Other",
          userKey: bobKey,
        },
      ]),
    ).toEqual([
      {
        id: "mine",
        kind: "system",
        scope: "personal",
        summary: "Concise replies",
      },
    ]);
  });
});
