import { describe, expect, it } from "vitest";
import { extractTelegramInput } from "../../../src/server/telegram/input";
import {
  chunkTelegramText,
  formatTelegramText,
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
  it("extracts only bounded opaque callbacks from private chats", () => {
    expect(
      extractTelegramInput({
        update_id: 9,
        callback_query: {
          id: "callback-id",
          from: { id: 4, first_name: "private" },
          message: { message_id: 8, chat: { id: 3, type: "private" } },
          data: "y_abcdefghijklmnopqrstuvwxyz123456",
        },
      }),
    ).toEqual({
      kind: "callback",
      updateId: "9",
      callbackQueryId: "callback-id",
      messageId: "8",
      chatId: "3",
      userId: "4",
      username: undefined,
      languageCode: undefined,
      data: "y_abcdefghijklmnopqrstuvwxyz123456",
    });
    expect(
      extractTelegramInput({
        update_id: 10,
        callback_query: {
          id: "bad",
          from: { id: 4 },
          message: { message_id: 8, chat: { id: 3, type: "private" } },
          data: "not opaque!",
        },
      }).kind,
    ).toBe("ignored");
  });
  it("losslessly chunks long output", () => {
    const text = "a".repeat(9000);
    const chunks = chunkTelegramText(text);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every((x) => x.length <= 4096)).toBe(true);
  });
  it("removes Markdown punctuation while retaining readable structure", () => {
    expect(
      formatTelegramText(
        "## Summary\n- **Open interest:** $52.89B\n> `Note`\n\n[Source](https://example.com)",
      ),
    ).toBe(
      "Summary\n• Open interest: $52.89B\n│ Note\n\nSource (https://example.com)",
    );
  });
  it("sends polished plain text without exposing formatting markers", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));
    const client = new TelegramClient("fixture-token", request);
    await client.send("3", "## Result\n- **exact** response");
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.parse(request.mock.calls[0]![1]!.body as string)).toEqual({
      chat_id: "3",
      text: "Result\n• exact response",
    });
  });
});
