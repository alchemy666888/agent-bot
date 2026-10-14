import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import {
  readScheduleConfig,
  readTelegramConfig,
} from "../../../../server/config";
import { fetchNewsMcpClock } from "../../../../server/news-mcp/datetime";
import { runDueSchedules } from "../../../../server/schedules/run";
import { dispatchTelegramInput } from "../../../../server/telegram/dispatch";
import { TelegramClient } from "../../../../worker/telegram/client";
import {
  assistantTimeZone,
  calendarClock,
} from "../../../../shared/calendar-clock";
import { uuidV7 } from "../../../../shared/ids";
import { persistControllerLog } from "../../../../shared/postgres/controller-log";
import {
  claimDueSchedules,
  completeSchedule,
  failSchedule,
  hasActiveSchedule,
} from "../../../../shared/schedules/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const headers = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  const correlationId = uuidV7();
  const started = Date.now();
  let secret: string;
  try {
    secret = readScheduleConfig().SCHEDULE_API_SECRET;
  } catch {
    return NextResponse.json({ ok: false }, { status: 401, headers });
  }
  const authorization = request.headers.get("authorization");
  if (
    !authorization ||
    authorization.includes(",") ||
    !authorization.startsWith("Bearer ") ||
    !secretEqual(authorization.slice("Bearer ".length), secret)
  )
    return NextResponse.json({ ok: false }, { status: 401, headers });

  try {
    const telegram = readTelegramConfig();
    const client = new TelegramClient(telegram.TELEGRAM_BOT_TOKEN);
    const result = await runDueSchedules({
      leaseOwner: correlationId,
      hasActive: hasActiveSchedule,
      clock: async () => {
        const timeZone = assistantTimeZone();
        const sampled = await fetchNewsMcpClock({ timeZone });
        return sampled.ok ? sampled.clock : calendarClock(new Date(), timeZone);
      },
      claim: claimDueSchedules,
      complete: completeSchedule,
      fail: async (id, leaseOwner, nextRunAt) => {
        const failure = await failSchedule(id, leaseOwner, nextRunAt);
        if (!failure) return undefined;
        return {
          paused: failure.paused,
          publicId: failure.publicId,
          chatId: failure.chatId,
          replyLocale: failure.metadata.replyLocale,
        };
      },
      dispatch: async (turn, turnCorrelationId) => {
        const response = await dispatchTelegramInput(turn, turnCorrelationId);
        return response.ok;
      },
      notify: (chatId, text) => client.send(chatId, text),
    });
    await persistControllerLog({
      correlationId,
      component: "controller",
      operation: "scheduleRun",
      stage: "complete",
      result: "success",
      durationMs: Date.now() - started,
      ...(result.status === 200
        ? { metadata: { ran: result.ran, failed: result.failed } }
        : {}),
    });
    if (result.status === 204)
      return new NextResponse(null, { status: 204, headers });
    return NextResponse.json(
      { ok: true, ran: result.ran, failed: result.failed },
      { headers },
    );
  } catch {
    await persistControllerLog({
      correlationId,
      component: "controller",
      operation: "scheduleRun",
      stage: "dispatch",
      result: "failure",
      durationMs: Date.now() - started,
      code: "SCHEDULE_RUN_FAILED",
    });
    return NextResponse.json({ ok: false }, { status: 503, headers });
  }
}

function secretEqual(candidate: string, expected: string): boolean {
  if (!candidate || !expected) return false;
  const left = createHash("sha256").update(candidate).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}
