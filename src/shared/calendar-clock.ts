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
  hour: number;
  minute: number;
  weekday: string;
  timeZone: string;
  source: "news_mcp" | "local_fallback";
};

/** Absolute date or time named in a user request. Missing fields were not named. */
export type SpecifiedDateTime = {
  year?: number;
  month?: number;
  day?: number;
  hour?: number;
  minute?: number;
};

export const UNAVAILABLE_CLOCK_RULE =
  "The news-mcp clock is unavailable. Do not invent the current year, month, day, hour, or minute. If the user specifies an absolute historical or future date or time, use only that specified value for web search and the answer. Otherwise say the current date and time could not be read and do not present unverified news as current.";

export function unavailableClockRule(request = ""): string {
  const specified = userSpecifiedDateTimes(request).slice(0, 5);
  if (!specified.length) return UNAVAILABLE_CLOCK_RULE;
  return `${UNAVAILABLE_CLOCK_RULE} The user specified: ${specified.map(formatSpecified).join(", ")}. Use that specified date and time for web search and the answer.`;
}

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
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const year = Number(read("year"));
  const month = Number(read("month"));
  const day = Number(read("day"));
  const hour = Number(read("hour"));
  return {
    isoDate: `${read("year")}-${read("month")}-${read("day")}`,
    year,
    month,
    day,
    hour: hour === 24 ? 0 : hour,
    minute: Number(read("minute")),
    weekday: read("weekday") || weekdayName(year, month, day),
    timeZone,
    source: "local_fallback",
  };
}

export function trustedCalendarContext(
  clock: CalendarClock,
): Array<{ key: string; value: string }> {
  return [
    { key: "current_date", value: clock.isoDate },
    { key: "current_year", value: String(clock.year) },
    { key: "current_month", value: String(clock.month) },
    { key: "current_day", value: String(clock.day) },
    { key: "current_hour", value: String(clock.hour) },
    { key: "current_minute", value: String(clock.minute) },
    { key: "weekday", value: clock.weekday },
    { key: "timezone", value: clock.timeZone },
    { key: "clock_source", value: clock.source },
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
  const hour = boundedField(instructions, "current_hour", 0, 23);
  const minute = boundedField(instructions, "current_minute", 0, 59);
  const source = instructions.match(
    /(?:^|\n)clock_source:\s*(news_mcp|local_fallback)\b/,
  );
  return {
    isoDate: `${date[1]}-${date[2]}-${date[3]}`,
    year,
    month,
    day,
    hour: hour ?? fallback.hour,
    minute: minute ?? fallback.minute,
    weekday: weekday?.[1] ?? weekdayName(year, month, day),
    timeZone: zone?.[1] ?? fallback.timeZone,
    source:
      source?.[1] === "news_mcp" || source?.[1] === "local_fallback"
        ? source[1]
        : fallback.source,
  };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function clockLabel(clock: CalendarClock): string {
  const origin = clock.source === "news_mcp" ? "news-mcp" : "server";
  return `The trusted ${origin} clock is ${clock.weekday}, ${clock.isoDate} ${pad(clock.hour)}:${pad(clock.minute)} (${clock.timeZone}). Year ${clock.year}, month ${clock.month}, day ${clock.day}, hour ${clock.hour}, minute ${clock.minute}.`;
}

export function formatSpecified(spec: SpecifiedDateTime): string {
  const date =
    spec.year !== undefined &&
    spec.month !== undefined &&
    spec.day !== undefined
      ? `${spec.year}-${pad(spec.month)}-${pad(spec.day)}`
      : spec.year !== undefined && spec.month !== undefined
        ? `${spec.year}-${pad(spec.month)}`
        : spec.year !== undefined
          ? String(spec.year)
          : "";
  if (spec.hour === undefined) return date;
  const time = `${pad(spec.hour)}:${pad(spec.minute ?? 0)}`;
  return date ? `${date} ${time}` : time;
}

/** Dates and clock times the user named. Relative words such as "today" are not matches. */
export function userSpecifiedDateTimes(request: string): SpecifiedDateTime[] {
  const text = visibleUserRequest(request);
  const found: Array<SpecifiedDateTime & { start: number; end: number }> = [];
  const overlaps = (start: number, end: number) =>
    found.some((item) => start < item.end && end > item.start);
  const add = (match: RegExpMatchArray, spec: SpecifiedDateTime) => {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (overlaps(start, end) || !validSpecified(spec)) return;
    found.push({ ...spec, start, end });
  };

  for (const match of text.matchAll(
    /\b(20\d{2})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2}))?\b/g,
  ))
    add(match, {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      ...(match[4] !== undefined
        ? { hour: Number(match[4]), minute: Number(match[5]) }
        : {}),
    });
  for (const match of text.matchAll(/\b(20\d{2})[/.](\d{1,2})[/.](\d{1,2})\b/g))
    add(match, {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
    });
  for (const match of text.matchAll(
    /(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?(?:\s*(上午|下午|晚上|凌晨)?\s*(\d{1,2})\s*(?:[:：]|點|点|時|时)\s*(\d{1,2})?)?/g,
  )) {
    const hour = namedHour(match[5], match[4]);
    add(match, {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      ...(hour === undefined
        ? {}
        : { hour, minute: match[6] === undefined ? 0 : Number(match[6]) }),
    });
  }
  for (const match of text.matchAll(
    /\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*)\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(20\d{2})(?:\s+at\s+(\d{1,2})(?::(\d{2}))?(?:\s*(am|pm))?|\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b)?/gi,
  )) {
    const month = ENGLISH_MONTH[match[1]!.toLowerCase()];
    if (!month) continue;
    const hourText = match[4] ?? match[7];
    const minuteText = match[5] ?? match[8];
    const hour = namedHour(hourText, match[4] ? match[6] : match[9]);
    add(match, {
      year: Number(match[3]),
      month,
      day: Number(match[2]),
      ...(hour === undefined
        ? {}
        : { hour, minute: minuteText === undefined ? 0 : Number(minuteText) }),
    });
  }
  for (const match of text.matchAll(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*)\s+(20\d{2})\b/gi,
  )) {
    const month = ENGLISH_MONTH[match[2]!.toLowerCase()];
    if (!month) continue;
    add(match, {
      year: Number(match[3]),
      month,
      day: Number(match[1]),
    });
  }
  for (const match of text.matchAll(/(20\d{2})\s*年\s*(\d{1,2})\s*月/g))
    add(match, { year: Number(match[1]), month: Number(match[2]) });
  for (const match of text.matchAll(/\b(20\d{2})\b/g))
    add(match, { year: Number(match[1]) });
  for (const match of text.matchAll(
    /(上午|下午|晚上|凌晨)\s*(\d{1,2})\s*(?:點|点|時|时)(?:\s*(\d{1,2}))?/g,
  )) {
    const hour = namedHour(match[2], match[1]);
    if (hour === undefined) continue;
    add(match, {
      hour,
      minute: match[3] === undefined ? 0 : Number(match[3]),
    });
  }
  for (const match of text.matchAll(/\b(\d{1,2}):(\d{2})\s*(am|pm)\b/gi)) {
    const hour = namedHour(match[1], match[3]);
    if (hour === undefined) continue;
    add(match, { hour, minute: Number(match[2]) });
  }
  return found.map(({ year, month, day, hour, minute }) => ({
    ...(year === undefined ? {} : { year }),
    ...(month === undefined ? {} : { month }),
    ...(day === undefined ? {} : { day }),
    ...(hour === undefined ? {} : { hour }),
    ...(minute === undefined ? {} : { minute }),
  }));
}

export function applicableSpecifications(
  clock: CalendarClock,
  request: string,
): SpecifiedDateTime[] {
  return userSpecifiedDateTimes(request).filter((spec) => {
    if (spec.hour !== undefined || spec.minute !== undefined) return true;
    if (spec.month !== undefined || spec.day !== undefined) return true;
    return spec.year !== undefined && spec.year !== clock.year;
  });
}

export function datetimeOperatingRule(
  clock: CalendarClock,
  request = "",
): string {
  const specified = applicableSpecifications(clock, request).slice(0, 5);
  if (specified.length) {
    return `${clockLabel(clock)} The user specified this historical or future date and time: ${specified.map(formatSpecified).join(", ")}. For web search and the answer, use the user-specified date and time instead of the current clock.`;
  }
  return `${clockLabel(clock)} For news, calendars, and upcoming events, search with year ${clock.year}, month ${clock.month}, day ${clock.day}, hour ${clock.hour}, and minute ${clock.minute}. Mention only events confirmed for the requested dates in ${clock.year}. A prior-year item that shares the month and day is a different event. Do not list a central-bank speech, data release, holiday, or earnings date from another year unless a ${clock.year} source schedules it again. Compute every weekday from ${clock.year}.`;
}

export function calendarYearRule(clock: CalendarClock, request = ""): string {
  return datetimeOperatingRule(clock, request);
}

export function staleCalendarCorrection(clock: CalendarClock): string {
  return `The previous draft lists news or events that do not belong to ${clock.year}. The trusted clock is ${clock.weekday}, ${clock.isoDate} ${String(clock.hour).padStart(2, "0")}:${String(clock.minute).padStart(2, "0")} (${clock.timeZone}). Search again for the user's requested period in ${clock.year} only. Drop every event supported only by an earlier year, including a central-bank speech, data release, holiday, or earnings date that merely shares the month and day. Recompute each weekday for ${clock.year}. If an event cannot be confirmed for ${clock.year}, omit it.`;
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

const POLITE_PREFIX =
  /^(?:(?:hi|hey|hello|please|can you|could you|would you|tell me|let me know)(?:[,，!\s]+|$)|(?:請問|请问|問下|问下|唔該|唔该|你好|麻煩你?|麻烦你?|你可唔可以|可不可以|可以唔可以|能不能|告訴我|告诉我|話我知|话我知|講下|讲下)[，,\s]*)/iu;

const TIME_CORE =
  /^(?:what(?:'s| is) the (?:current )?time(?: now)?|what time is it(?: now)?|what is the time(?: now)?|current time|(?:the )?time now|(?:而家|現在|现在|現時|现时|當前|当前)(?:係|系|是)?(?:幾[點点](?:鐘|钟)?|几[點点](?:鐘|钟)?|幾多[點点]|几多[點点]|什麼時間|什么时间|什麼時候|什么时候|時間|时间)|幾[點点](?:鐘|钟)?了|几[點点](?:鐘|钟)?了)$/iu;

/** A request that asks only for the current time, with no other topic. */
export function isCurrentTimeRequest(request: string): boolean {
  let text = visibleUserRequest(request)
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[?？。!！.～~]+$/u, "")
    .replace(/(?:呢|嗎|吗|啊|呀|啦|了|吧)+$/u, "")
    .trim();
  if (!text || text.length > 80) return false;
  for (let i = 0; i < 4; i++) {
    const next = text.replace(POLITE_PREFIX, "").trim();
    if (next === text) break;
    text = next;
  }
  return TIME_CORE.test(text);
}

function timeReplyLanguage(request: string): "yue" | "zh" | "en" {
  const text = visibleUserRequest(request);
  if (/而家|喺|咩/.test(text)) return "yue";
  if (/[A-Za-z]/.test(text) && !/\p{Script=Han}/u.test(text)) return "en";
  return "zh";
}

/** User-facing clock answer. Undefined when the request is not time-only. */
export function currentTimeReply(
  request: string,
  clock: CalendarClock | undefined,
): string | undefined {
  if (!isCurrentTimeRequest(request)) return undefined;
  const language = timeReplyLanguage(request);
  if (!clock) {
    if (language === "en")
      return "The current date and time could not be read.";
    if (language === "yue") return "而家嘅日期同時間讀取唔到。";
    return "現在的日期和時間讀取不到。";
  }
  const time = `${pad(clock.hour)}:${pad(clock.minute)}`;
  const place = spokenTimeZone(clock.timeZone, language);
  if (language === "en")
    return place ? `It is ${time} ${place}.` : `It is ${time}.`;
  if (language === "yue")
    return place ? `而家係 ${place}${time}。` : `而家係 ${time}。`;
  return place ? `現在是 ${place}${time}。` : `現在是 ${time}。`;
}

/** Spoken zone for a clock answer. Hong Kong is named; other zones stay unnamed. */
function spokenTimeZone(
  timeZone: string,
  language: "yue" | "zh" | "en",
): string | undefined {
  if (timeZone !== "Asia/Hong_Kong") return undefined;
  return language === "en" ? "Hong Kong time" : "香港時間";
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

function boundedField(
  instructions: string,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const match = instructions.match(
    new RegExp(`(?:^|\\n)${key}:\\s*(\\d{1,2})\\b`),
  );
  if (!match) return undefined;
  const value = Number(match[1]);
  return value >= min && value <= max ? value : undefined;
}

function namedHour(
  hour: string | undefined,
  meridiem: string | undefined,
): number | undefined {
  if (hour === undefined) return undefined;
  const value = Number(hour);
  if (!Number.isInteger(value) || value < 0 || value > 23) return undefined;
  const marker = meridiem?.toLowerCase();
  if (marker === "pm" || marker === "下午" || marker === "晚上")
    return value < 12 ? value + 12 : value;
  if (marker === "am" || marker === "上午" || marker === "凌晨")
    return value === 12 ? 0 : value;
  return value;
}

function validSpecified(spec: SpecifiedDateTime): boolean {
  if (spec.month !== undefined && (spec.month < 1 || spec.month > 12))
    return false;
  if (spec.day !== undefined && (spec.day < 1 || spec.day > 31)) return false;
  if (
    spec.year !== undefined &&
    spec.month !== undefined &&
    spec.day !== undefined &&
    !validDate(spec.year, spec.month, spec.day)
  )
    return false;
  if (spec.hour !== undefined && (spec.hour < 0 || spec.hour > 23))
    return false;
  if (spec.minute !== undefined && (spec.minute < 0 || spec.minute > 59))
    return false;
  return (
    spec.year !== undefined ||
    spec.month !== undefined ||
    spec.day !== undefined ||
    spec.hour !== undefined
  );
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
