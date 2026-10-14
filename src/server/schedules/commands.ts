import "server-only";

import { assistantTimeZone, calendarClock } from "../../shared/calendar-clock";
import { executeScheduleCommand } from "../../shared/schedules/service";
import { parseScheduleCommand } from "../../shared/schedules/spec";
import { postgresScheduleRepository } from "../../shared/schedules/repository";
import { fetchNewsMcpClock } from "../news-mcp/datetime";

export type ScheduleMessage = {
  text: string;
  userId: string;
  chatId: string;
  username?: string;
  languageCode?: string;
  updateId: string;
  messageId: string;
};

/** Schedule control never calls the model. The clock is the live news-mcp value. */
export async function replyToScheduleMessage(
  input: ScheduleMessage,
): Promise<string | undefined> {
  const command = parseScheduleCommand(input.text);
  if (!command) return undefined;
  const timeZone = assistantTimeZone();
  const sampled = await fetchNewsMcpClock({ timeZone });
  const clock = sampled.ok
    ? sampled.clock
    : calendarClock(new Date(), timeZone);
  return executeScheduleCommand(
    command,
    {
      userId: input.userId,
      chatId: input.chatId,
      username: input.username,
      languageCode: input.languageCode,
      updateId: input.updateId,
      messageId: input.messageId,
      sourceMessage: input.text,
    },
    postgresScheduleRepository(),
    clock,
  );
}
