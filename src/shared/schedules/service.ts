import type { ScheduleClock } from "./types";
import type { ScheduleRepository } from "./types";
import type { ScheduleActor } from "./types";
import type { ScheduleCommand } from "./spec";
import {
  MAX_SCHEDULE_PROMPT_LENGTH,
  MAX_SCHEDULE_SOURCE_LENGTH,
  MAX_SCHEDULES_PER_USER,
  clockInstant,
  nextOccurrence,
} from "./spec";
import {
  scheduleCreated,
  scheduleLimit,
  scheduleList,
  scheduleMissing,
  schedulePromptTooLong,
  scheduleStarted,
  scheduleStopped,
  scheduleUsage,
} from "./messages";

const USERNAME = /^[A-Za-z0-9_]{5,32}$/;

export async function executeScheduleCommand(
  command: ScheduleCommand,
  actor: ScheduleActor,
  repository: ScheduleRepository,
  clock: ScheduleClock,
): Promise<string> {
  if (command.action === "usage") return scheduleUsage(command.locale);
  if (command.action === "list") {
    const tasks = await repository.listByOwner(actor.userId);
    return scheduleList(
      command.locale,
      tasks.map((task) => ({
        publicId: task.publicId,
        status: task.status,
        spec: task.metadata.schedule,
        prompt: task.userPrompt,
      })),
    );
  }
  if (command.action === "stop" || command.action === "start") {
    const existing = (await repository.listByOwner(actor.userId)).find(
      (task) => task.publicId === command.publicId,
    );
    if (!existing) return scheduleMissing(command.locale);
    if (command.action === "stop") {
      if (existing.status === "paused")
        return scheduleStopped(command.locale, command.publicId, "already");
      const updated = await repository.setStatus(
        actor.userId,
        command.publicId,
        "paused",
      );
      return updated
        ? scheduleStopped(command.locale, command.publicId, "paused")
        : scheduleMissing(command.locale);
    }
    if (existing.status === "active")
      return scheduleStarted(
        command.locale,
        command.publicId,
        "already",
        existing.nextRunAt,
        clock,
      );
    const nextRunAt =
      existing.nextRunAt.getTime() > clockInstant(clock).getTime()
        ? existing.nextRunAt
        : nextOccurrence(existing.metadata.schedule, clock);
    const updated = await repository.setStatus(
      actor.userId,
      command.publicId,
      "active",
      nextRunAt,
    );
    return updated
      ? scheduleStarted(
          command.locale,
          command.publicId,
          "active",
          updated.nextRunAt,
          clock,
        )
      : scheduleMissing(command.locale);
  }
  if (command.prompt.length > MAX_SCHEDULE_PROMPT_LENGTH)
    return schedulePromptTooLong(command.locale);
  if (actor.sourceMessage.length > MAX_SCHEDULE_SOURCE_LENGTH)
    return scheduleUsage(command.locale);
  const created = await repository.create({
    ownerTelegramUserId: actor.userId,
    chatId: actor.chatId,
    username:
      actor.username && USERNAME.test(actor.username) ? actor.username : null,
    languageCode: actor.languageCode?.slice(0, 16) ?? null,
    sourceMessage: actor.sourceMessage,
    userPrompt: command.prompt,
    metadata: {
      schedule: command.spec,
      timeZone: clock.timeZone,
      clockSource: clock.source,
      sourceUpdateId: actor.updateId,
      sourceMessageId: actor.messageId,
      replyLocale: command.locale,
    },
    nextRunAt: nextOccurrence(command.spec, clock),
  });
  if (!created.ok) return scheduleLimit(command.locale, MAX_SCHEDULES_PER_USER);
  return scheduleCreated(command.locale, created.task.publicId, command.spec);
}
