import { describe, expect, it } from "vitest";
import type { CalendarClock } from "../../../../src/shared/calendar-clock";
import {
  clockInstant,
  nextOccurrence,
  parseScheduleCommand,
  utcFromCivil,
} from "../../../../src/shared/schedules/spec";

const clock = (hour: number, minute: number): CalendarClock => ({
  isoDate: "2026-10-14",
  year: 2026,
  month: 10,
  day: 14,
  hour,
  minute,
  weekday: "Wednesday",
  timeZone: "Asia/Hong_Kong",
  source: "news_mcp",
});

describe("schedule commands", () => {
  it("parses an English daily schedule and keeps the prompt", () => {
    expect(parseScheduleCommand("/schedule daily 09:00 今日新聞")).toEqual({
      action: "create",
      locale: "zh",
      spec: { kind: "daily", hour: 9, minute: 0 },
      prompt: "今日新聞",
    });
  });

  it("parses Chinese create, list, stop, and start messages", () => {
    expect(parseScheduleCommand("設定排程 每 15 分鐘 檢查天氣")).toMatchObject({
      action: "create",
      spec: { kind: "interval", minutes: 15 },
      prompt: "檢查天氣",
    });
    expect(parseScheduleCommand("排程列表")).toMatchObject({ action: "list" });
    expect(parseScheduleCommand("停止排程 abcd1234")).toMatchObject({
      action: "stop",
      publicId: "abcd1234",
    });
    expect(parseScheduleCommand("啟動排程 abcd1234")).toMatchObject({
      action: "start",
    });
  });

  it("rejects a schedule command that has no prompt", () => {
    expect(parseScheduleCommand("/schedule hourly")).toMatchObject({
      action: "usage",
      locale: "en",
    });
  });

  it("leaves ordinary chat alone", () => {
    expect(parseScheduleCommand("今天香港新聞")).toBeUndefined();
  });

  it("places 09:00 Hong Kong at 01:00 UTC", () => {
    expect(
      utcFromCivil(2026, 10, 14, 9, 0, "Asia/Hong_Kong").toISOString(),
    ).toBe("2026-10-14T01:00:00.000Z");
    expect(clockInstant(clock(9, 0)).toISOString()).toBe(
      "2026-10-14T01:00:00.000Z",
    );
  });

  it("schedules the next civil slot after the trusted minute", () => {
    expect(
      nextOccurrence(
        { kind: "daily", hour: 9, minute: 0 },
        clock(8, 0),
      ).toISOString(),
    ).toBe("2026-10-14T01:00:00.000Z");
    expect(
      nextOccurrence(
        { kind: "daily", hour: 9, minute: 0 },
        clock(9, 0),
      ).toISOString(),
    ).toBe("2026-10-15T01:00:00.000Z");
    expect(
      nextOccurrence({ kind: "hourly", minute: 0 }, clock(10, 0)).toISOString(),
    ).toBe("2026-10-14T03:00:00.000Z");
    expect(
      nextOccurrence(
        { kind: "interval", minutes: 15 },
        clock(10, 7),
      ).toISOString(),
    ).toBe("2026-10-14T02:15:00.000Z");
  });
});
