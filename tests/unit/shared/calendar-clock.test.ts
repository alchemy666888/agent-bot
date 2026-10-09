import { describe, expect, it } from "vitest";
import {
  answerConflictsWithCalendar,
  calendarClock,
  civilWeekday,
  visibleUserRequest,
} from "../../../src/shared/calendar-clock";

const clock = calendarClock(
  new Date("2026-10-09T06:41:00.000Z"),
  "Asia/Hong_Kong",
);
const nextWeek = "下個星期有什麼會議或者事件需要交易者注意的嗎？";
const powell =
  "美聯儲主席鮑威爾在 NABE 年會發表演說，談經濟展望與貨幣政策，是利率預期的關鍵";

describe("calendar clock", () => {
  it("uses the 2026 civil calendar for the Hong Kong clock", () => {
    expect(clock).toMatchObject({
      isoDate: "2026-10-09",
      year: 2026,
      weekday: "Friday",
      timeZone: "Asia/Hong_Kong",
    });
    expect(civilWeekday(2026, 10, 13)).toBe(2);
    expect(civilWeekday(2025, 10, 13)).toBe(1);
  });

  it("rejects a prior-year weekday and a prior-year dated speech", () => {
    expect(
      answerConflictsWithCalendar(`週一（10/13）\n${powell}`, clock, nextWeek),
    ).toBe(true);
    expect(
      answerConflictsWithCalendar(`2025年10月14日 ${powell}`, clock, nextWeek),
    ).toBe(true);
    expect(
      answerConflictsWithCalendar(
        "週二（10/13）\n這週沒有確認到鮑威爾的 NABE 演說。",
        clock,
        nextWeek,
      ),
    ).toBe(false);
  });

  it("keeps an explicit question about 2025", () => {
    expect(
      answerConflictsWithCalendar(
        `週一（10/13）\n${powell}`,
        clock,
        "2025年10月有什麼事件？",
      ),
    ).toBe(false);
  });

  it("reads the current-year request from the Telegram envelope", () => {
    const envelope = `Answer the request.\n${JSON.stringify({
      data: Buffer.from(nextWeek, "utf8").toString("base64"),
    })}`;
    expect(visibleUserRequest(envelope)).toBe(nextWeek);
    expect(
      answerConflictsWithCalendar(`週一（10/13）\n${powell}`, clock, envelope),
    ).toBe(true);
  });
});
