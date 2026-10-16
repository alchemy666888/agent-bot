import type { CalendarClock } from "../calendar-clock";

export const MAX_SCHEDULES_PER_USER = 20;
export const MAX_SCHEDULE_PROMPT_LENGTH = 2_000;
export const MAX_SCHEDULE_SOURCE_LENGTH = 4_000;

export type ScheduleSpec =
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "hourly"; minute: number }
  | { kind: "interval"; minutes: number };

export type ScheduleLocale = "zh" | "en";

export type ScheduleCommand =
  | { action: "usage"; locale: ScheduleLocale }
  | {
      action: "create";
      locale: ScheduleLocale;
      spec: ScheduleSpec;
      prompt: string;
    }
  | { action: "list"; locale: ScheduleLocale }
  | { action: "stop"; locale: ScheduleLocale; publicId: string }
  | { action: "start"; locale: ScheduleLocale; publicId: string };

const SLASH =
  /^\s*\/(schedules|schedule_stop|schedule_start|schedule)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/iu;

export function parseScheduleCommand(
  text: string,
): ScheduleCommand | undefined {
  const locale = commandLocale(text);
  const trimmed = text.trim();
  if (/^(?:排程列表|列出排程)$/u.test(trimmed))
    return { action: "list", locale: "zh" };
  const stop = trimmed.match(/^停止排程\s+([a-f0-9]{8})$/iu);
  if (stop)
    return { action: "stop", locale: "zh", publicId: stop[1]!.toLowerCase() };
  const start = trimmed.match(/^(?:啟動排程|重新啟動排程)\s+([a-f0-9]{8})$/iu);
  if (start)
    return { action: "start", locale: "zh", publicId: start[1]!.toLowerCase() };
  const created = trimmed.match(/^設定排程(?:\s+([\s\S]+))?$/u);
  if (created) return parseCreate(created[1] ?? "", "zh");

  const slash = text.match(SLASH);
  if (!slash) return undefined;
  const name = slash[1]!.toLowerCase();
  const args = (slash[2] ?? "").trim();
  if (name === "schedules") return { action: "list", locale };
  const id = args.match(/^([a-f0-9]{8})$/iu);
  if (name === "schedule_stop")
    return id
      ? { action: "stop", locale, publicId: id[1]!.toLowerCase() }
      : { action: "usage", locale };
  if (name === "schedule_start")
    return id
      ? { action: "start", locale, publicId: id[1]!.toLowerCase() }
      : { action: "usage", locale };
  return parseCreate(args, locale);
}

function parseCreate(body: string, locale: ScheduleLocale): ScheduleCommand {
  const text = body.trim();
  const daily = text.match(
    /^(?:daily|每天|每日)\s*(\d{1,2})[:：](\d{2})(?:\s+([\s\S]+))?$/iu,
  );
  if (daily) {
    const hour = Number(daily[1]);
    const minute = Number(daily[2]);
    const prompt = daily[3]?.trim() ?? "";
    if (hour > 23 || minute > 59 || !prompt) return { action: "usage", locale };
    return {
      action: "create",
      locale,
      spec: { kind: "daily", hour, minute },
      prompt,
    };
  }
  const hourly = text.match(
    /^(?:hourly|每\s*小時|每\s*小时)(?:\s+([\s\S]+))?$/iu,
  );
  if (hourly) {
    const prompt = hourly[1]?.trim() ?? "";
    if (!prompt) return { action: "usage", locale };
    return {
      action: "create",
      locale,
      spec: { kind: "hourly", minute: 0 },
      prompt,
    };
  }
  const interval = text.match(
    /^(?:every|每)\s*(\d{1,4})\s*(?:minutes|mins|min|m|分鐘|分钟)(?:\s+([\s\S]+))?$/iu,
  );
  if (interval) {
    const minutes = Number(interval[1]);
    const prompt = interval[2]?.trim() ?? "";
    if (minutes < 1 || minutes > 1_440 || !prompt)
      return { action: "usage", locale };
    return {
      action: "create",
      locale,
      spec: { kind: "interval", minutes },
      prompt,
    };
  }
  return { action: "usage", locale };
}

function commandLocale(text: string): ScheduleLocale {
  return /[\u3400-\u9fff]/u.test(text) ? "zh" : "en";
}

export function formatSchedule(
  spec: ScheduleSpec,
  locale: ScheduleLocale,
): string {
  const minute = String(spec.kind === "interval" ? 0 : spec.minute).padStart(
    2,
    "0",
  );
  if (spec.kind === "daily") {
    const hour = String(spec.hour).padStart(2, "0");
    return locale === "zh"
      ? `每天 ${hour}:${minute}`
      : `daily ${hour}:${minute}`;
  }
  if (spec.kind === "hourly") return locale === "zh" ? "每小時" : "hourly";
  return locale === "zh" ? `每 ${spec.minutes} 分鐘` : `every ${spec.minutes}m`;
}

/** Civil clock fields in `timeZone`, expressed as a UTC instant. */
export function utcFromCivil(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  let utc = Date.UTC(year, month - 1, day, hour, minute, 0);
  for (let attempt = 0; attempt < 3; attempt++) {
    const next =
      Date.UTC(year, month - 1, day, hour, minute, 0) -
      civilOffsetMs(new Date(utc), timeZone);
    if (next === utc) break;
    utc = next;
  }
  return new Date(utc);
}

export function clockInstant(clock: CalendarClock): Date {
  return utcFromCivil(
    clock.year,
    clock.month,
    clock.day,
    clock.hour,
    clock.minute,
    clock.timeZone,
  );
}

/** The first occurrence strictly after the trusted civil minute. */
export function nextOccurrence(spec: ScheduleSpec, clock: CalendarClock): Date {
  if (spec.kind === "daily") {
    const later =
      clock.hour > spec.hour ||
      (clock.hour === spec.hour && clock.minute >= spec.minute);
    const day = later
      ? addDays(clock.year, clock.month, clock.day, 1)
      : { year: clock.year, month: clock.month, day: clock.day };
    return utcFromCivil(
      day.year,
      day.month,
      day.day,
      spec.hour,
      spec.minute,
      clock.timeZone,
    );
  }
  if (spec.kind === "hourly") {
    let hour = clock.hour;
    let day = { year: clock.year, month: clock.month, day: clock.day };
    if (clock.minute >= spec.minute) {
      hour += 1;
      if (hour === 24) {
        hour = 0;
        day = addDays(day.year, day.month, day.day, 1);
      }
    }
    return utcFromCivil(
      day.year,
      day.month,
      day.day,
      hour,
      spec.minute,
      clock.timeZone,
    );
  }
  const minuteOfDay = clock.hour * 60 + clock.minute;
  const next = (Math.floor(minuteOfDay / spec.minutes) + 1) * spec.minutes;
  const spilled = next >= 24 * 60;
  const minute = spilled ? next % (24 * 60) : next;
  const day = spilled
    ? addDays(clock.year, clock.month, clock.day, 1)
    : { year: clock.year, month: clock.month, day: clock.day };
  return utcFromCivil(
    day.year,
    day.month,
    day.day,
    Math.floor(minute / 60),
    minute % 60,
    clock.timeZone,
  );
}

function addDays(year: number, month: number, day: number, delta: number) {
  const shifted = new Date(Date.UTC(year, month - 1, day + delta));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function civilOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  const hour = value("hour") === 24 ? 0 : value("hour");
  const civil = Date.UTC(
    value("year"),
    value("month") - 1,
    value("day"),
    hour,
    value("minute"),
    value("second"),
  );
  return civil - instant.getTime();
}
