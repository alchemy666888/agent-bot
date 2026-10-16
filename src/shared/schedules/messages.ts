import type { CalendarClock } from "../calendar-clock";
import { calendarClock } from "../calendar-clock";
import { formatSchedule, type ScheduleLocale, type ScheduleSpec } from "./spec";

export function scheduleUsage(locale: ScheduleLocale): string {
  if (locale === "zh")
    return [
      "設定排程：設定排程 每天 09:00 <提示>",
      "也可以：設定排程 每小時 <提示>、設定排程 每 15 分鐘 <提示>",
      "列出：排程列表",
      "停止：停止排程 <id>",
      "重新啟動：啟動排程 <id>",
      "英文指令：/schedule daily 09:00 <prompt>、/schedule hourly <prompt>、/schedule every 15m <prompt>、/schedules、/schedule_stop <id>、/schedule_start <id>",
    ].join("\n");
  return [
    "Create: /schedule daily 09:00 <prompt>",
    "Also: /schedule hourly <prompt> or /schedule every 15m <prompt>",
    "List: /schedules",
    "Stop: /schedule_stop <id>",
    "Restart: /schedule_start <id>",
    "中文：設定排程 每天 09:00 <提示>、排程列表、停止排程 <id>、啟動排程 <id>",
  ].join("\n");
}

export function scheduleCreated(
  locale: ScheduleLocale,
  publicId: string,
  spec: ScheduleSpec,
): string {
  const when = formatSchedule(spec, locale);
  return locale === "zh"
    ? `已設定排程 ${publicId}（${when}）。到時我會在這裡回覆。`
    : `Scheduled ${publicId} (${when}). I'll reply here when it runs.`;
}

export function scheduleList(
  locale: ScheduleLocale,
  tasks: readonly {
    publicId: string;
    status: "active" | "paused";
    spec: ScheduleSpec;
    prompt: string;
  }[],
): string {
  if (tasks.length === 0)
    return locale === "zh" ? "你還沒有排程。" : "You have no schedules.";
  const lines = tasks.map((task) => {
    const state =
      task.status === "active"
        ? locale === "zh"
          ? "執行中"
          : "active"
        : locale === "zh"
          ? "已停止"
          : "paused";
    return `${task.publicId} · ${state} · ${formatSchedule(task.spec, locale)} · ${clip(task.prompt)}`;
  });
  const hint =
    locale === "zh"
      ? "停止：停止排程 <id>\n重新啟動：啟動排程 <id>"
      : "Stop: /schedule_stop <id>\nRestart: /schedule_start <id>";
  return [locale === "zh" ? "你的排程" : "Your schedules", ...lines, hint].join(
    "\n",
  );
}

export function scheduleStopped(
  locale: ScheduleLocale,
  publicId: string,
  state: "paused" | "already",
): string {
  if (state === "already")
    return locale === "zh"
      ? `排程 ${publicId} 已經停止。`
      : `Schedule ${publicId} is already stopped.`;
  return locale === "zh"
    ? `已停止排程 ${publicId}。`
    : `Stopped schedule ${publicId}.`;
}

export function scheduleStarted(
  locale: ScheduleLocale,
  publicId: string,
  state: "active" | "already",
  nextRunAt: Date,
  clock: CalendarClock,
): string {
  if (state === "already")
    return locale === "zh"
      ? `排程 ${publicId} 已在運行。`
      : `Schedule ${publicId} is already running.`;
  const when = formatInstant(nextRunAt, clock.timeZone);
  return locale === "zh"
    ? `已重新啟動排程 ${publicId}。下次運行 ${when}。`
    : `Restarted schedule ${publicId}. Next run ${when}.`;
}

export function scheduleMissing(locale: ScheduleLocale): string {
  return locale === "zh" ? "找不到這個排程。" : "No schedule with that id.";
}

export function scheduleLimit(locale: ScheduleLocale, limit: number): string {
  return locale === "zh"
    ? `排程已達上限（${limit}）。先停止一個再用。`
    : `You already have ${limit} schedules. Stop one before adding another.`;
}

export function schedulePromptTooLong(locale: ScheduleLocale): string {
  return locale === "zh"
    ? "排程提示最長 2000 個字。"
    : "A schedule prompt can be at most 2000 characters.";
}

function clip(prompt: string): string {
  const flat = prompt.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
}

function formatInstant(instant: Date, timeZone: string): string {
  const clock = calendarClock(instant, timeZone);
  const hour = String(clock.hour).padStart(2, "0");
  const minute = String(clock.minute).padStart(2, "0");
  return `${clock.isoDate} ${hour}:${minute}`;
}
