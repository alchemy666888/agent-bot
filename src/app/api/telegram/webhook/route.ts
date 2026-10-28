import { after, NextResponse } from "next/server";
import { readTelegramConfig } from "../../../../server/config";
import { dispatchTelegramInput } from "../../../../server/telegram/dispatch";
import {
  extractTelegramInput,
  type TelegramInput,
} from "../../../../server/telegram/input";
import { uuidV7 } from "../../../../shared/ids";
import {
  logException,
  logStructured,
  safeError,
} from "../../../../shared/logger";
import {
  failureContext,
  type FailureContext,
} from "../../../../shared/worker-progress";
import { TelegramClient } from "../../../../worker/telegram/client";
import {
  claimWebhookFailure,
  releaseWebhookFailure,
  webhookFailureClaimed,
} from "./failure-ack";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Acknowledge pending work promptly; after() retains it within maxDuration. */
export const WEBHOOK_ACK_MS = 1_000;

const TURN_FAILED_TEXT = "這次回覆沒有完成，請再傳一次。";
const headers = { "Cache-Control": "no-store" };

type DispatchResponse = Awaited<ReturnType<typeof dispatchTelegramInput>>;
type SettledDispatch =
  | { state: "settled"; response: DispatchResponse }
  | { state: "failed"; error: unknown };

function privateChatId(input: TelegramInput): string | undefined {
  if (!("chatId" in input)) return undefined;
  if (input.chatId.startsWith("-")) return undefined;
  if ("chatScope" in input && input.chatScope === "group") return undefined;
  return input.chatId;
}

function continueTurn(task: () => Promise<void>, correlationId: string): void {
  const guarded = () =>
    task().catch((error: unknown) => {
      logException(error, {
        correlationId,
        component: "controller",
        operation: "telegramWebhook",
        stage: "background",
      });
    });
  try {
    after(guarded);
  } catch {
    void guarded();
  }
}

async function notifyTurnFailed(
  token: string,
  chatId: string,
  text: string,
  correlationId: string,
): Promise<boolean> {
  try {
    await new TelegramClient(token).send(chatId, text, undefined, undefined, {
      plain: true,
    });
    return true;
  } catch (error) {
    logException(error, {
      correlationId,
      component: "controller",
      operation: "telegramWebhook",
      stage: "failure-notification",
    });
    return false;
  }
}

function accepted(): NextResponse {
  return NextResponse.json({ ok: true }, { headers });
}

async function privateFailure(
  token: string,
  chatId: string,
  updateId: string,
  text: string,
  correlationId: string,
): Promise<NextResponse> {
  if (!(await claimWebhookFailure(updateId))) return accepted();
  if (await notifyTurnFailed(token, chatId, text, correlationId))
    return accepted();
  await releaseWebhookFailure(updateId);
  return NextResponse.json({ ok: false }, { status: 503, headers });
}

function failureMetadata(
  failure: ReturnType<typeof safeError>,
  context?: FailureContext,
): Record<string, unknown> | undefined {
  const metadata = {
    error: failure,
    ...(failure.diagnostic ?? {}),
    ...(context?.operation ? { operation: context.operation } : {}),
    ...(context?.timeoutLimitMs === undefined
      ? {}
      : { timeoutLimitMs: context.timeoutLimitMs }),
    ...(context?.progress ? { progress: context.progress } : {}),
    ...(failure.detail ? { detail: failure.detail } : {}),
    ...(failure.trace?.length ? { trace: failure.trace } : {}),
  };
  return Object.keys(metadata).length ? metadata : undefined;
}

async function finishDispatch(
  outcome: SettledDispatch,
  input: TelegramInput,
  correlationId: string,
  started: number,
  token: string,
): Promise<NextResponse> {
  const chatId = privateChatId(input);
  const durationMs = Date.now() - started;
  if (outcome.state === "failed") {
    const failure = safeError(outcome.error, "INTERNAL_ERROR", "dispatch");
    const context = failureContext(outcome.error);
    const metadata = failureMetadata(failure, context);
    logException(outcome.error, {
      correlationId,
      component: "controller",
      operation: "telegramWebhook",
      stage: "dispatch",
      durationMs,
      code: failure.code,
      ...(metadata ? { metadata } : {}),
    });
    if (chatId)
      return privateFailure(
        token,
        chatId,
        input.updateId,
        TURN_FAILED_TEXT,
        correlationId,
      );
    return NextResponse.json({ ok: false }, { status: 503, headers });
  }
  if (!outcome.response.ok) {
    const retryable = outcome.response.error?.classification === "transient";
    const reported = outcome.response.error;
    const metadata = reported
      ? {
          error: reported,
          ...(reported.diagnostic ?? {}),
          ...(reported.detail ? { detail: reported.detail } : {}),
          ...(reported.trace?.length ? { trace: reported.trace } : {}),
        }
      : undefined;
    logStructured({
      correlationId,
      component: "controller",
      operation: "telegramWebhook",
      stage: "worker",
      result: "failure",
      durationMs,
      code: reported?.code ?? "WORKER_FAILED",
      ...(metadata && Object.keys(metadata).length ? { metadata } : {}),
    });
    if (chatId)
      return privateFailure(
        token,
        chatId,
        input.updateId,
        TURN_FAILED_TEXT,
        correlationId,
      );
    return NextResponse.json(
      { ok: false },
      { status: retryable ? 503 : 500, headers },
    );
  }
  logStructured({
    correlationId,
    component: "controller",
    operation: "telegramWebhook",
    stage: "complete",
    result: "success",
    durationMs: Date.now() - started,
  });
  return accepted();
}

export async function POST(request: Request) {
  const correlationId = uuidV7();
  const started = Date.now();
  const config = readTelegramConfig();
  if (
    request.headers.get("x-telegram-bot-api-secret-token") !==
    config.TELEGRAM_WEBHOOK_SECRET
  )
    return NextResponse.json({ ok: false }, { status: 401, headers });
  let input;
  try {
    input = extractTelegramInput(await request.json());
  } catch {
    return NextResponse.json({ ok: false }, { status: 400, headers });
  }
  const chatId = privateChatId(input);
  if (chatId && (await webhookFailureClaimed(input.updateId)))
    return accepted();

  const dispatched: Promise<SettledDispatch> = dispatchTelegramInput(
    input,
    correlationId,
  ).then(
    (response) => ({ state: "settled", response }),
    (error: unknown) => ({ state: "failed", error }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<{ state: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ state: "timeout" }), WEBHOOK_ACK_MS);
  });
  const winner = await Promise.race([dispatched, timedOut]);
  clearTimeout(timer);
  if (winner.state === "timeout") {
    continueTurn(async () => {
      await finishDispatch(
        await dispatched,
        input,
        correlationId,
        started,
        config.TELEGRAM_BOT_TOKEN,
      );
    }, correlationId);
    return accepted();
  }
  return finishDispatch(
    winner,
    input,
    correlationId,
    started,
    config.TELEGRAM_BOT_TOKEN,
  );
}
