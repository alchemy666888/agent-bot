import { describe, expect, it } from "vitest";
import type { CalendarClock } from "../../../../src/shared/calendar-clock";
import { executeScheduleCommand } from "../../../../src/shared/schedules/service";
import { MAX_SCHEDULES_PER_USER } from "../../../../src/shared/schedules/spec";
import type {
  ScheduleRepository,
  ScheduledTask,
} from "../../../../src/shared/schedules/types";

const clock: CalendarClock = {
  isoDate: "2026-10-14",
  year: 2026,
  month: 10,
  day: 14,
  hour: 8,
  minute: 30,
  weekday: "Wednesday",
  timeZone: "Asia/Hong_Kong",
  source: "news_mcp",
};

function memory(): ScheduleRepository & { tasks: ScheduledTask[] } {
  const tasks: ScheduledTask[] = [];
  return {
    tasks,
    async create(input) {
      if (
        tasks.filter(
          (task) => task.ownerTelegramUserId === input.ownerTelegramUserId,
        ).length >= MAX_SCHEDULES_PER_USER
      )
        return { ok: false, reason: "limit" };
      const task: ScheduledTask = {
        id: `id-${tasks.length + 1}`,
        publicId: `abc1234${tasks.length}`,
        ownerTelegramUserId: input.ownerTelegramUserId,
        chatId: input.chatId,
        username: input.username,
        languageCode: input.languageCode,
        sourceMessage: input.sourceMessage,
        userPrompt: input.userPrompt,
        metadata: input.metadata,
        status: "active",
        nextRunAt: input.nextRunAt,
        lastRunAt: null,
        failureCount: 0,
      };
      tasks.push(task);
      return { ok: true, task };
    },
    async listByOwner(userId) {
      return tasks.filter((task) => task.ownerTelegramUserId === userId);
    },
    async setStatus(userId, publicId, status, nextRunAt) {
      const task = tasks.find(
        (item) =>
          item.ownerTelegramUserId === userId && item.publicId === publicId,
      );
      if (!task) return undefined;
      task.status = status;
      if (nextRunAt) task.nextRunAt = nextRunAt;
      if (status === "active") task.failureCount = 0;
      return task;
    },
  };
}

const actor = {
  userId: "42",
  chatId: "42",
  updateId: "9",
  messageId: "8",
  sourceMessage: "設定排程 每天 09:00 今日新聞",
};

describe("schedule command service", () => {
  it("stores the source message, metadata, and user prompt", async () => {
    const repository = memory();
    const reply = await executeScheduleCommand(
      {
        action: "create",
        locale: "zh",
        spec: { kind: "daily", hour: 9, minute: 0 },
        prompt: "今日新聞",
      },
      actor,
      repository,
      clock,
    );
    expect(reply).toContain("abc12340");
    expect(repository.tasks[0]).toMatchObject({
      sourceMessage: actor.sourceMessage,
      userPrompt: "今日新聞",
      chatId: "42",
      metadata: {
        schedule: { kind: "daily", hour: 9, minute: 0 },
        clockSource: "news_mcp",
        replyLocale: "zh",
        sourceUpdateId: "9",
        sourceMessageId: "8",
      },
    });
    expect(repository.tasks[0]?.nextRunAt.toISOString()).toBe(
      "2026-10-14T01:00:00.000Z",
    );
  });

  it("lists, stops, and restarts only the owner's schedules", async () => {
    const repository = memory();
    await executeScheduleCommand(
      {
        action: "create",
        locale: "en",
        spec: { kind: "hourly", minute: 0 },
        prompt: "weather",
      },
      { ...actor, sourceMessage: "/schedule hourly weather" },
      repository,
      clock,
    );
    repository.tasks.push({
      ...repository.tasks[0]!,
      id: "other",
      publicId: "ffff0000",
      ownerTelegramUserId: "7",
      userPrompt: "secret",
    });
    const listed = await executeScheduleCommand(
      { action: "list", locale: "en" },
      actor,
      repository,
      clock,
    );
    expect(listed).toContain("weather");
    expect(listed).not.toContain("secret");
    expect(
      await executeScheduleCommand(
        { action: "stop", locale: "en", publicId: "ffff0000" },
        actor,
        repository,
        clock,
      ),
    ).toMatch(/No schedule/i);
    expect(
      await executeScheduleCommand(
        { action: "stop", locale: "en", publicId: "abc12340" },
        actor,
        repository,
        clock,
      ),
    ).toMatch(/Stopped/);
    expect(repository.tasks[0]?.status).toBe("paused");
    const restarted = await executeScheduleCommand(
      { action: "start", locale: "en", publicId: "abc12340" },
      actor,
      repository,
      clock,
    );
    expect(restarted).toMatch(/Restarted/);
    expect(repository.tasks[0]?.status).toBe("active");
  });
});
