import { describe, expect, it } from "vitest";
import { extractTelegramInput } from "../../../src/server/telegram/input";
import {
  chunkTelegramText,
  TelegramClient,
} from "../../../src/worker/telegram/client";
import { vi } from "vitest";
describe("Telegram contract", () => {
  it("drops names and raw update fields", () => {
    const value = extractTelegramInput({
      update_id: 1,
      message: {
        message_id: 2,
        chat: { id: 3, type: "private" },
        from: {
          id: 4,
          first_name: "private",
          last_name: "private",
          username: "u",
        },
        text: "hi",
      },
      secret: "raw",
    });
    expect(value).toEqual({
      kind: "text",
      updateId: "1",
      messageId: "2",
      chatId: "3",
      userId: "4",
      username: "u",
      languageCode: undefined,
      text: "hi",
    });
    expect(JSON.stringify(value)).not.toContain("private");
  });
  it("ignores groups and edited messages", () =>
    expect(
      extractTelegramInput({ update_id: 1, edited_message: {} }).kind,
    ).toBe("ignored"));
  it("losslessly chunks long output", () => {
    const text = "a".repeat(9000);
    const chunks = chunkTelegramText(text);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every((x) => x.length <= 4096)).toBe(true);
  });
  it("falls back to plain text without changing or regenerating content", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));
    const client = new TelegramClient("fixture-token", request);
    await client.send("3", "*exact* response");
    expect(request).toHaveBeenCalledTimes(2);
    expect(JSON.parse(request.mock.calls[0]![1]!.body as string)).toEqual({
      chat_id: "3",
      text: "*exact* response",
      parse_mode: "MarkdownV2",
    });
    expect(JSON.parse(request.mock.calls[1]![1]!.body as string)).toEqual({
      chat_id: "3",
      text: "*exact* response",
    });
  });
});
