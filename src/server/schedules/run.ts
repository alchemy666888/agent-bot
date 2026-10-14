import "server-only";

import { randomBytes } from "node:crypto";
import type { CalendarClock } from "../../shared/calendar-clock";
import { clockInstant, nextOccurrence } from "../../shared/schedules/spec";
import { schedulePausedAfterFailures } from "../../shared/schedules/messages";
import type { ScheduledTask } from "../../shared/schedules/types";
import type { TelegramInput } from "../telegram/input";

export type ScheduleRunResult =
  { status: 204 } | { status: 200; ran: number; failed: number };

export async function runDueSchedules(input: {
  leaseOwner: string;
  hasActive: () => Promise<boolean>;
  clock: () => Promise<CalendarClock>;
  claim: (now: Date, leaseOwner: string) => Promise<ScheduledTask[]>;
  complete: (id: string, leaseOwner: string, nextRunAt: Date) => Promise<void>;
  fail: (
    id: string,
    leaseOwner: string,
    nextRunAt: Date,
  ) => Promise<
    | {
        paused: boolean;
        publicId: string;
        chatId: string;
        replyLocale: "zh" | "en";
      }
    | undefined
  >;
  dispatch: (turn: TelegramInput, correlationId: string) => Promise<boolean>;
  notify: (chatId: string, text: string) => Promise<void>;
}): Promise<ScheduleRunResult> {
  if (!(await input.hasActive())) return { status: 204 };
  const clock = await input.clock();
  const due = await input.claim(clockInstant(clock), input.leaseOwner);
  if (due.length === 0) return { status: 204 };
  let ran = 0;
  let failed = 0;
  for (const [index, task] of due.entries()) {
    const correlationId = input.leaseOwner;
    const ok = await input
      .dispatch(scheduledTurn(task, index), correlationId)
      .catch(() => false);
    if (ok) {
      await input.complete(
        task.id,
        input.leaseOwner,
        nextOccurrence(task.metadata.schedule, clock),
      );
      ran += 1;
      continue;
    }
    failed += 1;
    const failure = await input.fail(
      task.id,
      input.leaseOwner,
      nextOccurrence(task.metadata.schedule, clock),
    );
    if (failure?.paused)
      await input
        .notify(
          failure.chatId,
          schedulePausedAfterFailures(failure.replyLocale, failure.publicId),
        )
        .catch(() => undefined);
  }
  return { status: 200, ran, failed };
}

export function scheduledTurn(
  task: ScheduledTask,
  index: number,
): TelegramInput {
  const suffix = String(index).padStart(2, "0");
  const noise = String(randomBytes(2).readUInt16BE(0) % 1000).padStart(3, "0");
  const stamp = `${Date.now()}${noise}${suffix}`;
  return {
    kind: "text",
    updateId: `8${stamp}`,
    messageId: `7${stamp}`,
    chatId: task.chatId,
    userId: task.ownerTelegramUserId,
    ...(task.username ? { username: task.username } : {}),
    ...(task.languageCode ? { languageCode: task.languageCode } : {}),
    text: task.userPrompt,
  };
}
