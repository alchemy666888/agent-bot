/** Trusted clock for news and event answers. Relative phrases such as "next
 * week" and "this year" are resolved from this value, not from model memory. */

export const DEFAULT_ASSISTANT_TIMEZONE = "Asia/Hong_Kong";

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const CJK_WEEKDAY: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  日: 0,
  天: 0,
};

const ENGLISH_WEEKDAY: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const ENGLISH_MONTH: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

const CURRENT_PERIOD =
  /今[個个]?星期|這[個个]?星期|这[个]?星期|下[個个]?星期|下週|下周|本週|本周|這週|这周|今[天日年]|明[天日]|後天|后天|這個?月|这个月|下[個个]?月|今年|本年|upcoming|next week|this week|this month|this year|today|tomorrow/iu;

const CJK_WEEKDAY_THEN_DATE =
  /(?:週|周|星期)([一二三四五六日天])\s*[（(]?\s*(\d{1,2})\s*[/／月.]\s*(\d{1,2})/gu;
const CJK_DATE_THEN_WEEKDAY =
  /(\d{1,2})\s*月\s*(\d{1,2})\s*日?\s*[（(]\s*(?:週|周|星期)([一二三四五六日天])/gu;
const ENGLISH_WEEKDAY_THEN_DATE =
  /\b(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\b\s*,?\s*\(?((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*)\s+(\d{1,2})\b/giu;
const ENGLISH_DATE_THEN_WEEKDAY =
  /\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*)\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*\(?\s*(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\b/giu;
const NUMERIC_YEAR_DATE =
  /\b(20\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/gu;
const ENGLISH_YEAR_DATE =
  /\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*)\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(20\d{2})\b/giu;

export type CalendarClock = {
  isoDate: string;
  year: number;
  month: number;
  day: number;
  weekday: string;
  timeZone: string;
};

export function assistantTimeZone(
  value = process.env.ASSISTANT_TIMEZONE,
): string {
  const zone = value?.trim() || DEFAULT_ASSISTANT_TIMEZONE;
  try {
    Intl.DateTimeFormat("en-US", { timeZone: zone }).format();
    return zone;
  } catch {
    return DEFAULT_ASSISTANT_TIMEZONE;
  }
}

export function civilWeekday(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function weekdayName(year: number, month: number, day: number): string {
  return WEEKDAYS[civilWeekday(year, month, day)] ?? "Sunday";
}

export function calendarClock(
  now = new Date(),
  timeZone = assistantTimeZone(),
): CalendarClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const year = Number(read("year"));
  const month = Number(read("month"));
  const day = Number(read("day"));
  return {
    isoDate: `${read("year")}-${read("month")}-${read("day")}`,
    year,
    month,
    day,
    weekday: read("weekday") || weekdayName(year, month, day),
    timeZone,
  };
}

export function trustedCalendarContext(
  clock: CalendarClock,
): Array<{ key: string; value: string }> {
  return [
    { key: "current_date", value: clock.isoDate },
    { key: "current_year", value: String(clock.year) },
    { key: "weekday", value: clock.weekday },
    { key: "timezone", value: clock.timeZone },
  ];
}

export function clockFromInstructions(
  instructions: string,
  fallback: CalendarClock,
): CalendarClock {
  const date = instructions.match(
    /(?:^|\n)current_date:\s*(\d{4})-(\d{2})-(\d{2})\b/,
  );
  if (!date) return fallback;
  const year = Number(date[1]);
  const month = Number(date[2]);
  const day = Number(date[3]);
  if (!validDate(year, month, day)) return fallback;
  const zone = instructions.match(
    /(?:^|\n)timezone:\s*([A-Za-z0-9_+/-]{1,64})/,
  );
  const weekday = instructions.match(
    /(?:^|\n)weekday:\s*(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\b/,
  );
  return {
    isoDate: `${date[1]}-${date[2]}-${date[3]}`,
    year,
    month,
    day,
    weekday: weekday?.[1] ?? weekdayName(year, month, day),
    timeZone: zone?.[1] ?? fallback.timeZone,
  };
}

export function calendarYearRule(clock: CalendarClock): string {
  return `The trusted clock is ${clock.weekday}, ${clock.isoDate} (${clock.timeZone}). For news, calendars, and upcoming events, search with ${clock.year} and mention only events confirmed for the requested dates in ${clock.year}. A prior-year item that shares the month and day is a different event. Do not list a central-bank speech, data release, holiday, or earnings date from another year unless a ${clock.year} source schedules it again. Compute every weekday from ${clock.year}.`;
}

export function staleCalendarCorrection(clock: CalendarClock): string {
  return `The previous draft lists news or events that do not belong to ${clock.year}. The trusted clock is ${clock.weekday}, ${clock.isoDate} (${clock.timeZone}). Search again for the user's requested period in ${clock.year} only. Drop every event supported only by an earlier year, including a central-bank speech, data release, holiday, or earnings date that merely shares the month and day. Recompute each weekday for ${clock.year}. If an event cannot be confirmed for ${clock.year}, omit it.`;
}

/** Decode a Telegram input envelope so relative dates are visible to checks. */
export function visibleUserRequest(content: string): string {
  const match = content.match(/"data"\s*:\s*"([A-Za-z0-9+/]+={0,2})"/);
  if (!match?.[1]) return content;
  try {
    const decoded = Buffer.from(match[1], "base64").toString("utf8");
    if (!decoded.trim() || decoded.includes("\uFFFD")) return content;
    return decoded;
  } catch {
    return content;
  }
}

export function requestNeedsCurrentCalendar(
  request: string,
  year: number,
): boolean {
  const text = visibleUserRequest(request);
  if (!CURRENT_PERIOD.test(text)) return false;
  return ![...text.matchAll(/\b(20\d{2})\b/g)].some(
    (match) => Number(match[1]) !== year,
  );
}

export function answerConflictsWithCalendar(
  answer: string,
  clock: CalendarClock,
  request: string,
): boolean {
  if (!requestNeedsCurrentCalendar(request, clock.year)) return false;
  if (hasForeignFullDate(answer, clock.year)) return true;
  return hasWeekdayMismatch(answer, clock.year);
}

function validDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  return new Date(Date.UTC(year, month - 1, day)).getUTCDate() === day;
}

function yearBefore(text: string, index: number): number | undefined {
  const years = [
    ...text.slice(Math.max(0, index - 48), index).matchAll(/\b(20\d{2})\b/g),
  ];
  const last = years.at(-1);
  return last ? Number(last[1]) : undefined;
}

function hasForeignFullDate(answer: string, year: number): boolean {
  const numeric = [...answer.matchAll(NUMERIC_YEAR_DATE)].some((match) => {
    const stated = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    return stated !== year && validDate(stated, month, day);
  });
  if (numeric) return true;
  return [...answer.matchAll(ENGLISH_YEAR_DATE)].some((match) => {
    const month = ENGLISH_MONTH[match[1]!.toLowerCase()];
    const day = Number(match[2]);
    const stated = Number(match[3]);
    return (
      month !== undefined && stated !== year && validDate(stated, month, day)
    );
  });
}

function hasWeekdayMismatch(answer: string, year: number): boolean {
  const claims: Array<{
    index: number;
    weekday: number;
    month: number;
    day: number;
  }> = [];
  for (const match of [...answer.matchAll(CJK_WEEKDAY_THEN_DATE)])
    claims.push({
      index: match.index ?? 0,
      weekday: CJK_WEEKDAY[match[1]!] ?? -1,
      month: Number(match[2]),
      day: Number(match[3]),
    });
  for (const match of [...answer.matchAll(CJK_DATE_THEN_WEEKDAY)])
    claims.push({
      index: match.index ?? 0,
      weekday: CJK_WEEKDAY[match[3]!] ?? -1,
      month: Number(match[1]),
      day: Number(match[2]),
    });
  for (const match of [...answer.matchAll(ENGLISH_WEEKDAY_THEN_DATE)]) {
    const month = ENGLISH_MONTH[match[2]!.toLowerCase()];
    if (!month) continue;
    claims.push({
      index: match.index ?? 0,
      weekday: ENGLISH_WEEKDAY[match[1]!.toLowerCase()] ?? -1,
      month,
      day: Number(match[3]),
    });
  }
  for (const match of [...answer.matchAll(ENGLISH_DATE_THEN_WEEKDAY)]) {
    const month = ENGLISH_MONTH[match[1]!.toLowerCase()];
    if (!month) continue;
    claims.push({
      index: match.index ?? 0,
      weekday: ENGLISH_WEEKDAY[match[3]!.toLowerCase()] ?? -1,
      month,
      day: Number(match[2]),
    });
  }
  return claims.some((claim) => {
    const statedYear = yearBefore(answer, claim.index) ?? year;
    if (!validDate(statedYear, claim.month, claim.day)) return false;
    if (statedYear !== year) return true;
    return civilWeekday(statedYear, claim.month, claim.day) !== claim.weekday;
  });
}
