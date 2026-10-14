import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  hasActiveSchedule,
  claimDueSchedules,
  completeSchedule,
  failSchedule,
  dispatchTelegramInput,
  fetchNewsMcpClock,
} = vi.hoisted(() => ({
  hasActiveSchedule: vi.fn(),
  claimDueSchedules: vi.fn(),
  completeSchedule: vi.fn(),
  failSchedule: vi.fn(),
  dispatchTelegramInput: vi.fn(),
  fetchNewsMcpClock: vi.fn(),
}));

vi.mock("../../../src/server/config", () => ({
  readScheduleConfig: () => ({ SCHEDULE_API_SECRET: "schedule-secret" }),
  readTelegramConfig: () => ({
    TELEGRAM_BOT_TOKEN: "token",
    TELEGRAM_WEBHOOK_SECRET: "webhook",
    ALLOW_USERS: { ids: new Set(["42"]), usernames: new Set() },
  }),
}));
vi.mock("../../../src/shared/schedules/repository", () => ({
  hasActiveSchedule,
  claimDueSchedules,
  completeSchedule,
  failSchedule,
}));
vi.mock("../../../src/server/news-mcp/datetime", () => ({
  fetchNewsMcpClock,
}));
vi.mock("../../../src/server/telegram/dispatch", () => ({
  dispatchTelegramInput,
}));

import { POST } from "../../../src/app/api/schedules/run/route";

const request = (secret = "schedule-secret") =>
  new Request("https://example.test/api/schedules/run", {
    method: "POST",
    headers: { authorization: `Bearer ${secret}` },
  });

describe("schedule run API", () => {
  beforeEach(() => {
    hasActiveSchedule.mockReset();
    claimDueSchedules.mockReset();
    dispatchTelegramInput.mockReset();
    fetchNewsMcpClock.mockReset();
    hasActiveSchedule.mockResolvedValue(false);
  });

  it("rejects a missing bearer token before reading schedules", async () => {
    const response = await POST(
      new Request("https://example.test/api/schedules/run", { method: "POST" }),
    );
    expect(response.status).toBe(401);
    expect(hasActiveSchedule).not.toHaveBeenCalled();
    expect(dispatchTelegramInput).not.toHaveBeenCalled();
  });

  it("returns 204 and does not call the model when nothing is due", async () => {
    const response = await POST(request());
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(fetchNewsMcpClock).not.toHaveBeenCalled();
    expect(dispatchTelegramInput).not.toHaveBeenCalled();
  });

  it("dispatches a due task with the stored prompt and trusted clock", async () => {
    hasActiveSchedule.mockResolvedValue(true);
    fetchNewsMcpClock.mockResolvedValue({
      ok: true,
      clock: {
        isoDate: "2026-10-14",
        year: 2026,
        month: 10,
        day: 14,
        hour: 9,
        minute: 0,
        weekday: "Wednesday",
        timeZone: "Asia/Hong_Kong",
        source: "news_mcp",
      },
    });
    claimDueSchedules.mockImplementation(async () => [
      {
        id: "11111111-1111-7111-8111-111111111111",
        publicId: "abcd1234",
        ownerTelegramUserId: "42",
        chatId: "99",
        username: null,
        languageCode: null,
        sourceMessage: "/schedule daily 09:00 weather",
        userPrompt: "weather",
        metadata: {
          schedule: { kind: "daily", hour: 9, minute: 0 },
          timeZone: "Asia/Hong_Kong",
          clockSource: "news_mcp",
          sourceUpdateId: "1",
          sourceMessageId: "2",
          replyLocale: "en",
        },
        status: "active",
        nextRunAt: new Date("2026-10-14T01:00:00.000Z"),
        lastRunAt: null,
        failureCount: 0,
      },
    ]);
    dispatchTelegramInput.mockResolvedValue({ ok: true });
    completeSchedule.mockResolvedValue(undefined);
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(dispatchTelegramInput).toHaveBeenCalledTimes(1);
    expect(dispatchTelegramInput.mock.calls[0]?.[0]).toMatchObject({
      kind: "text",
      userId: "42",
      chatId: "99",
      text: "weather",
    });
    expect(fetchNewsMcpClock).toHaveBeenCalled();
  });
});
