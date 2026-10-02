import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { derivePromptUserKey } from "../../../../src/server/prompts/identity";

describe("prompt identity", () => {
  it("derives a constant-format keyed namespace", () => {
    const secret = "a sufficiently long server-side secret value";
    const expected = createHmac("sha256", secret)
      .update("123456")
      .digest("base64url");
    expect(derivePromptUserKey(secret, "123456")).toBe(`u1_${expected}`);
    expect(derivePromptUserKey(secret, "123456")).toHaveLength(46);
    expect(derivePromptUserKey(`${secret}!`, "123456")).not.toBe(
      derivePromptUserKey(secret, "123456"),
    );
  });

  it("rejects invalid identity inputs and weak secrets", () => {
    expect(() => derivePromptUserKey("short", "123")).toThrow();
    expect(() => derivePromptUserKey("x".repeat(32), "../123")).toThrow();
    expect(() => derivePromptUserKey("x".repeat(32), "0")).toThrow();
  });
});
