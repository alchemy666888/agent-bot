import { describe, expect, it } from "vitest";
import { ConversationService } from "../../../../src/worker/conversations/service";
import { commandReply } from "../../../../src/worker/commands";
describe("conversation domain", () => {
  it("stores only approved profile fields and preserves first seen", () => {
    const s = new ConversationService();
    s.contact({ id: 1, username: "u", at: "2026-01-01T00:00:00Z" });
    const p = s.contact({
      id: 1,
      languageCode: "fr",
      at: "2026-02-01T00:00:00Z",
    });
    expect(p).toEqual({
      telegramUserId: "1",
      username: "u",
      languageCode: "fr",
      firstSeenAt: "2026-01-01T00:00:00Z",
      lastSeenAt: "2026-02-01T00:00:00Z",
    });
    expect(p).not.toHaveProperty("firstName");
  });
  it("uses only twenty complete pairs and clears context on new", () => {
    const s = new ConversationService();
    for (let i = 0; i < 21; i++) {
      s.add("1", "user", `u${i}`);
      s.add("1", "assistant", `a${i}`);
    }
    expect(s.context("1", "system").messages).toHaveLength(41);
    expect(s.context("1", "system").messages[1]?.content).toBe("u1");
    s.newConversation("1");
    expect(s.context("1", "system").messages).toHaveLength(1);
  });
  it("returns deterministic commands without privacy notice", () => {
    expect(commandReply("/start")).not.toMatch(/privacy|retention/i);
    expect(commandReply("/help")).toContain("/new");
  });
});
