import { z } from "zod";
import type { CalendarClock } from "../calendar-clock";
import type { ScheduleLocale, ScheduleSpec } from "./spec";

export const scheduleSpecSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("daily"),
      hour: z.number().int().min(0).max(23),
      minute: z.number().int().min(0).max(59),
    })
    .strict(),
  z
    .object({
      kind: z.literal("hourly"),
      minute: z.number().int().min(0).max(59),
    })
    .strict(),
  z
    .object({
      kind: z.literal("interval"),
      minutes: z.number().int().min(1).max(1_440),
    })
    .strict(),
]);

export const scheduleMetadataSchema = z
  .object({
    schedule: scheduleSpecSchema,
    timeZone: z.string().min(1).max(64),
    clockSource: z.enum(["news_mcp", "local_fallback"]),
    sourceUpdateId: z.string().regex(/^\d+$/),
    sourceMessageId: z.string().regex(/^\d+$/),
    replyLocale: z.enum(["zh", "en"]),
  })
  .strict();

export type ScheduleMetadata = z.infer<typeof scheduleMetadataSchema>;

export type ScheduledTask = {
  id: string;
  publicId: string;
  ownerTelegramUserId: string;
  chatId: string;
  username: string | null;
  languageCode: string | null;
  sourceMessage: string;
  userPrompt: string;
  metadata: ScheduleMetadata;
  status: "active" | "paused";
  nextRunAt: Date;
  lastRunAt: Date | null;
  failureCount: number;
};

export type ScheduleActor = {
  userId: string;
  chatId: string;
  username?: string;
  languageCode?: string;
  updateId: string;
  messageId: string;
  sourceMessage: string;
};

export type ScheduleRepository = {
  create(input: {
    ownerTelegramUserId: string;
    chatId: string;
    username: string | null;
    languageCode: string | null;
    sourceMessage: string;
    userPrompt: string;
    metadata: ScheduleMetadata;
    nextRunAt: Date;
  }): Promise<
    { ok: true; task: ScheduledTask } | { ok: false; reason: "limit" }
  >;
  listByOwner(userId: string): Promise<ScheduledTask[]>;
  setStatus(
    userId: string,
    publicId: string,
    status: "active" | "paused",
    nextRunAt?: Date,
  ): Promise<ScheduledTask | undefined>;
};

export type ScheduleClock = CalendarClock;

export function replyLocaleOf(metadata: ScheduleMetadata): ScheduleLocale {
  return metadata.replyLocale;
}

export function specOf(metadata: ScheduleMetadata): ScheduleSpec {
  return metadata.schedule;
}
