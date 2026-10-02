import { describe, expect, it } from "vitest";
import {
  InMemoryConfirmationStore,
  parseConfirmationCallback,
  parseConfirmationText,
  PromptConfirmationService,
} from "../../../src/server/prompts/confirmation";

const actor = { canonicalId: "42", userKey: `u1_${"a".repeat(43)}` };
const binding = {
  actor,
  chatId: "42",
  target: { scope: "personal" as const, userKey: actor.userKey },
  operation: "delete" as const,
  kind: "request" as const,
  promptId: "writing",
  sanitizedSummary: "use concise answers",
  contentDigest: "a".repeat(64),
  baseCommitSha: "b".repeat(40),
};

describe("prompt confirmation", () => {
  it("requires two fresh, actor-bound confirmations before committing", async () => {
    const service = new PromptConfirmationService(
      new InMemoryConfirmationStore(),
    );
    const first = await service.propose(binding);
    const firstCallback = parseConfirmationCallback(
      first.buttons[0].callbackData,
    )!;
    const second = await service.respond({
      actor,
      chatId: "42",
      ...firstCallback,
    });
    expect(second.status).toBe("second_confirmation");
    expect(
      await service.respond({ actor, chatId: "42", ...firstCallback }),
    ).toEqual({ status: "ignored" });
    const finalCallback = parseConfirmationCallback(
      second.prompt!.buttons[0].callbackData,
    )!;
    expect(
      await service.respond({ actor, chatId: "42", ...finalCallback }),
    ).toMatchObject({ status: "committing" });
    expect(
      await service.respond({ actor, chatId: "42", ...finalCallback }),
    ).toEqual({ status: "ignored" });
  });

  it("accepts only explicit text fallback words", () => {
    expect(parseConfirmationText("yes")).toBe("yes");
    expect(parseConfirmationText("yes, please")).toBeNull();
    expect(parseConfirmationText("no")).toBe("no");
  });
});
