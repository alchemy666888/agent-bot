import { describe, expect, it } from "vitest";
import { derivePromptUserKey } from "../../../src/server/prompts/identity";
import { mayPersistPreference } from "../../../src/shared/redaction";

describe("prompt privacy contract", () => {
  it("does not place the enumerable Telegram ID in the namespace", () => {
    const key = derivePromptUserKey(
      "server secret with at least thirty two bytes",
      "987654321",
    );
    expect(key).toMatch(/^u1_[A-Za-z0-9_-]{43}$/);
    expect(key).not.toContain("987654321");
  });

  it("defaults uncertain, inferred, and sensitive preferences to no persistence", () => {
    expect(
      mayPersistPreference({
        text: "Probably likes short answers",
        modelClassification: "uncertain",
      }),
    ).toBe(false);
    expect(
      mayPersistPreference({
        text: "Remember my medical diagnosis",
        explicitlyPersistent: true,
        modelClassification: "persistent",
      }),
    ).toBe(false);
    expect(
      mayPersistPreference({
        text: "Always use concise answers",
        modelClassification: "persistent",
      }),
    ).toBe(true);
  });
});
