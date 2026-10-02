import { describe, expect, it } from "vitest";
import { isPromptAuthorized } from "../../../src/server/prompts/authorization";

describe("prompt authorization contract", () => {
  it("reauthorizes targets independently of the selected route", () => {
    const actor = { canonicalId: "7", userKey: `u1_${"x".repeat(43)}` };
    expect(
      isPromptAuthorized({
        actor,
        action: "read",
        target: { scope: "personal", userKey: `u1_${"y".repeat(43)}` },
      }),
    ).toBe(false);
    expect(
      isPromptAuthorized({
        actor,
        action: "update",
        target: { scope: "global" },
        operatorIds: new Set(["8"]),
      }),
    ).toBe(false);
  });
});
