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
  it("keeps sender identity on non-text messages", () => {
    expect(
      extractTelegramInput({
        update_id: 3,
        message: {
          message_id: 4,
          chat: { id: 5, type: "private" },
          from: { id: 6, first_name: "private", username: "LuckyVickyForever" },
          photo: [],
        },
      }),
    ).toEqual({
      kind: "unsupported",
      updateId: "3",
      chatId: "5",
      userId: "6",
      username: "LuckyVickyForever",
    });
    expect(
      JSON.stringify(
        extractTelegramInput({
          update_id: 3,
          message: {
            message_id: 4,
            chat: { id: 5, type: "private" },
            from: {
              id: 6,
              first_name: "private",
              username: "LuckyVickyForever",
            },
            photo: [],
          },
        }),
      ),
    ).not.toContain("private");
  });
  it("ignores edited messages, channels, and group chats", () => {
    expect(
      extractTelegramInput({ update_id: 1, edited_message: {} }).kind,
    ).toBe("ignored");
    expect(
      extractTelegramInput({
        update_id: 2,
        message: {
          message_id: 3,
          chat: { id: -100, type: "channel" },
          from: { id: 4 },
          text: "hi",
        },
      }).kind,
    ).toBe("ignored");
    for (const type of ["group", "supergroup"] as const) {
      expect(
        extractTelegramInput({
          update_id: 8,
          message: {
            message_id: 9,
            chat: { id: -100123, type, title: "交易討論" },
            from: { id: 4, first_name: "Ada", username: "u" },
            text: "大家好",
          },
        }),
      ).toEqual({ kind: "ignored", updateId: "8" });
      expect(
        extractTelegramInput({
          update_id: 11,
          message: {
            message_id: 12,
            chat: { id: -42, type },
            from: { id: 4, username: "u" },
            text: "/skills",
          },
        }).kind,
      ).toBe("ignored");
      expect(
        extractTelegramInput({
          update_id: 13,
          message: {
            message_id: 14,
            chat: { id: -42, type },
            from: { id: 4 },
            photo: [],
          },
        }).kind,
      ).toBe("ignored");
    }
  });
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
  it("rewrites Markdown tables into labeled plain-text blocks", () => {
    expect(
      formatTelegramText(
        [
          "| 資產 | 已 price in 的部分 | 尚未 price in 的風險 |",
          "|---|---|---|",
          "| 加密 | 鷹派 FOMC、ETF 流出、高利率環境、一波去槓桿 | 中東再升級、油價再衝高、US10Y 再破新高、連環清算的尾部風險 |",
          "| 股票 | 估值倍數的初步壓縮、利率高企 | 美債收益率「壞的上升」是否繼續、盈利下修、流動性收縮 |",
          "| 黃金 | 地緣避險 + 央行買盤支撐，已漲到高位 | 實質利率（名目利率－通脹）若續升，金價可能反遭壓制 |",
          "| 原油 | 中東風險溢價已部分反映 | 供給中斷的實際兌現、或局勢突然降溫的雙向意外 |",
        ].join("\n"),
      ),
    ).toBe(
      [
        "加密",
        "已 price in 的部分：鷹派 FOMC、ETF 流出、高利率環境、一波去槓桿",
        "尚未 price in 的風險：中東再升級、油價再衝高、US10Y 再破新高、連環清算的尾部風險",
        "",
        "股票",
        "已 price in 的部分：估值倍數的初步壓縮、利率高企",
        "尚未 price in 的風險：美債收益率「壞的上升」是否繼續、盈利下修、流動性收縮",
        "",
        "黃金",
        "已 price in 的部分：地緣避險 + 央行買盤支撐，已漲到高位",
        "尚未 price in 的風險：實質利率（名目利率－通脹）若續升，金價可能反遭壓制",
        "",
        "原油",
        "已 price in 的部分：中東風險溢價已部分反映",
        "尚未 price in 的風險：供給中斷的實際兌現、或局勢突然降溫的雙向意外",
      ].join("\n"),
    );
  });
  it("keeps prose that merely contains pipes", () => {
    expect(formatTelegramText("選擇 A | 選擇 B 都可以")).toBe(
      "選擇 A | 選擇 B 都可以",
    );
  });
  it("removes leading bars from the one-sentence summary section", () => {
    expect(
      formatTelegramText(
        [
          "前文保留 | 這裡的直線。",
          "",
          "> 這則引用要留下",
          "",
          "四、一句話總結",
          "| AI 股能在 5% 美債收益率下繼續漲，靠的是「現在就能兌現的盈利",
          "> + 真實訂單 + 資金抱團」三件事，暫時壓過了折現率上升的估值傷",
          "| 害。但這不是高利率失效。",
          "",
          "五、後記",
          "> 這則引用也要留下",
        ].join("\n"),
      ),
    ).toBe(
      [
        "前文保留 | 這裡的直線。",
        "│ 這則引用要留下",
        "",
        "四、一句話總結",
        "AI 股能在 5% 美債收益率下繼續漲，靠的是「現在就能兌現的盈利",
        "+ 真實訂單 + 資金抱團」三件事，暫時壓過了折現率上升的估值傷",
        "害。但這不是高利率失效。",
        "",
        "五、後記",
        "│ 這則引用也要留下",
      ].join("\n"),
    );
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
  it("replies to the group message that was addressed", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));
    const client = new TelegramClient("fixture-token", request);
    await client.send("-100123", "你好", undefined, "9");
    expect(JSON.parse(request.mock.calls[0]![1]!.body as string)).toEqual({
      chat_id: "-100123",
      text: "你好",
      reply_parameters: { message_id: 9 },
    });
  });
});
