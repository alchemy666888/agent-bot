import { after, NextResponse } from "next/server";
import { readTelegramConfig } from "../../../../server/config";
import { dispatchTelegramInput } from "../../../../server/telegram/dispatch";
import {
  extractTelegramInput,
  type TelegramInput,
} from "../../../../server/telegram/input";
import { persistControllerLog } from "../../../../shared/postgres/controller-log";
import { uuidV7 } from "../../../../shared/ids";
import { safeError } from "../../../../shared/logger";
import { TelegramClient } from "../../../../worker/telegram/client";
import {
  claimWebhookFailure,
  releaseWebhookFailure,
  webhookFailureClaimed,
} from "./failure-ack";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Telegram stops waiting for a webhook after about 60 seconds. */
export const WEBHOOK_ACK_MS = 45_000;

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

function continueTurn(task: () => Promise<void>): void {
  const guarded = () => task().catch(() => undefined);
  try {
    after(guarded);
  } catch {
    void guarded();
  }
}

async function notifyTurnFailed(
  token: string,
  chatId: string,
): Promise<boolean> {
  try {
    await new TelegramClient(token).send(chatId, TURN_FAILED_TEXT);
    return true;
  } catch {
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
  correlationId: string,
): Promise<NextResponse> {
  if (!(await claimWebhookFailure(updateId, correlationId))) return accepted();
  if (await notifyTurnFailed(token, chatId)) return accepted();
  await releaseWebhookFailure(updateId);
  return NextResponse.json({ ok: false }, { status: 503, headers });
}

async function finishDispatch(
  outcome: SettledDispatch,
  input: TelegramInput,
  correlationId: string,
  started: number,
  token: string,
): Promise<NextResponse> {
  const chatId = privateChatId(input);
  if (outcome.state === "failed") {
    const failure = safeError(outcome.error, "INTERNAL_ERROR", "dispatch");
    await persistControllerLog({
      correlationId,
      component: "controller",
      operation: "telegramWebhook",
      stage: "dispatch",
      result: "failure",
      durationMs: Date.now() - started,
      code: failure.code,
      ...(failure.diagnostic ? { metadata: failure.diagnostic } : {}),
    });
    if (chatId)
      return privateFailure(token, chatId, input.updateId, correlationId);
    return NextResponse.json({ ok: false }, { status: 503, headers });
  }
  if (!outcome.response.ok) {
    const retryable = outcome.response.error?.classification === "transient";
    await persistControllerLog({
      correlationId,
      component: "controller",
      operation: "telegramWebhook",
      stage: "worker",
      result: "failure",
      durationMs: Date.now() - started,
      code: outcome.response.error?.code ?? "WORKER_FAILED",
      ...(outcome.response.error?.diagnostic
        ? { metadata: outcome.response.error.diagnostic }
        : {}),
    });
    if (chatId)
      return privateFailure(token, chatId, input.updateId, correlationId);
    return NextResponse.json(
      { ok: false },
      { status: retryable ? 503 : 500, headers },
    );
  }
  await persistControllerLog({
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
    });
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
