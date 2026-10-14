import { describe, expect, it, vi } from "vitest";
import type { CalendarClock } from "../../../../src/shared/calendar-clock";
import type { ScheduledTask } from "../../../../src/shared/schedules/types";
import { runDueSchedules } from "../../../../src/server/schedules/run";

const clock: CalendarClock = {
  isoDate: "2026-10-14",
  year: 2026,
  month: 10,
  day: 14,
  hour: 9,
  minute: 0,
  weekday: "Wednesday",
  timeZone: "Asia/Hong_Kong",
  source: "news_mcp",
};

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "11111111-1111-7111-8111-111111111111",
    publicId: "abcd1234",
    ownerTelegramUserId: "42",
    chatId: "42",
    username: "lucky",
    languageCode: "zh-Hant",
    sourceMessage: "設定排程 每天 09:00 今日新聞",
    userPrompt: "今日新聞",
    metadata: {
      schedule: { kind: "daily", hour: 9, minute: 0 },
      timeZone: "Asia/Hong_Kong",
      clockSource: "news_mcp",
      sourceUpdateId: "3",
      sourceMessageId: "4",
      replyLocale: "zh",
    },
    status: "active",
    nextRunAt: new Date("2026-10-14T01:00:00.000Z"),
    lastRunAt: null,
    failureCount: 0,
    ...overrides,
  };
}

describe("due schedule runner", () => {
  it("returns 204 without a clock read or model turn when nothing is active", async () => {
    const clockRead = vi.fn();
    const dispatch = vi.fn();
    const result = await runDueSchedules({
      leaseOwner: "0199aaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa",
      hasActive: async () => false,
      clock: clockRead,
      claim: async () => [],
      complete: async () => undefined,
      fail: async () => undefined,
      dispatch,
      notify: async () => undefined,
    });
    expect(result).toEqual({ status: 204 });
    expect(clockRead).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("returns 204 when active tasks are not due yet", async () => {
    const dispatch = vi.fn();
    const result = await runDueSchedules({
      leaseOwner: "0199aaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa",
      hasActive: async () => true,
      clock: async () => clock,
      claim: async () => [],
      complete: async () => undefined,
      fail: async () => undefined,
      dispatch,
      notify: async () => undefined,
    });
    expect(result).toEqual({ status: 204 });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("runs a due prompt as that user's Telegram turn", async () => {
    const due = task();
    const dispatch = vi.fn(async () => true);
    const complete = vi.fn(async () => undefined);
    const result = await runDueSchedules({
      leaseOwner: "0199aaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa",
      hasActive: async () => true,
      clock: async () => clock,
      claim: async (now) => {
        expect(now.toISOString()).toBe("2026-10-14T01:00:00.000Z");
        return [due];
      },
      complete,
      fail: async () => undefined,
      dispatch,
      notify: async () => undefined,
    });
    expect(result).toEqual({ status: 200, ran: 1, failed: 0 });
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      kind: "text",
      chatId: "42",
      userId: "42",
      text: "今日新聞",
      username: "lucky",
    });
    expect(complete).toHaveBeenCalledWith(
      due.id,
      "0199aaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa",
      new Date("2026-10-15T01:00:00.000Z"),
    );
  });
});
