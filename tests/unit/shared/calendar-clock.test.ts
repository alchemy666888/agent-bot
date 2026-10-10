import { describe, expect, it } from "vitest";
import {
  answerConflictsWithCalendar,
  calendarClock,
  calendarYearRule,
  civilWeekday,
  currentTimeReply,
  isCurrentTimeRequest,
  userSpecifiedDateTimes,
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
      month: 10,
      day: 9,
      hour: 14,
      minute: 41,
      weekday: "Friday",
      timeZone: "Asia/Hong_Kong",
      source: "local_fallback",
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

  it("keeps the news-mcp clock unless the user names another date or time", () => {
    expect(userSpecifiedDateTimes("下個星期有什麼新聞？")).toEqual([]);
    expect(calendarYearRule(clock, "今天香港天氣")).toContain(
      "hour 14, minute 41",
    );
    expect(calendarYearRule(clock, "今天香港天氣")).not.toContain(
      "user specified",
    );
    expect(userSpecifiedDateTimes("2024年3月15日下午3點30分的新聞")).toEqual([
      { year: 2024, month: 3, day: 15, hour: 15, minute: 30 },
    ]);
    expect(calendarYearRule(clock, "請查 2020-05-04 的新聞")).toContain(
      "2020-05-04",
    );
    expect(calendarYearRule(clock, "March 15, 2024 at 3:30 pm")).toContain(
      "2024-03-15 15:30",
    );
    expect(userSpecifiedDateTimes("2026年的新聞")).toEqual([{ year: 2026 }]);
    expect(calendarYearRule(clock, "2026年的新聞")).not.toContain(
      "user specified",
    );
    expect(calendarYearRule(clock, "2019 年發生了什麼？")).toContain("2019");
  });

  it("answers a pure time question from the clock and not a city", () => {
    const evening = { ...clock, hour: 18, minute: 48 };
    expect(isCurrentTimeRequest("現在幾點")).toBe(true);
    expect(isCurrentTimeRequest("而家幾點")).toBe(true);
    expect(isCurrentTimeRequest("what time is it")).toBe(true);
    expect(isCurrentTimeRequest("請問現在幾點？")).toBe(true);
    expect(isCurrentTimeRequest("現在幾點的天氣")).toBe(false);
    expect(isCurrentTimeRequest("現在幾點有什麼新聞")).toBe(false);
    expect(currentTimeReply("現在幾點", evening)).toBe(
      "現在是香港時間18:48。",
    );
    expect(currentTimeReply("而家幾點", evening)).toBe(
      "而家係香港時間18:48。",
    );
    expect(currentTimeReply("what time is it", evening)).toBe(
      "It is 18:48 Hong Kong time.",
    );
    expect(currentTimeReply("現在幾點", evening)).not.toContain(
      "Asia/Hong_Kong",
    );
    expect(currentTimeReply("現在幾點", evening)).not.toMatch(/廣州|广州/);
    expect(currentTimeReply("現在幾點", undefined)).toBe(
      "現在的日期和時間讀取不到。",
    );
    expect(currentTimeReply("今天香港天氣", evening)).toBeUndefined();
  });
});
