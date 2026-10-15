import { NextResponse } from "next/server";
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
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TURN_FAILED_TEXT = "這次回覆沒有完成，請再傳一次。";
const headers = { "Cache-Control": "no-store" };

function privateChatId(input: TelegramInput): string | undefined {
  if (!("chatId" in input)) return undefined;
  if (input.chatId.startsWith("-")) return undefined;
  if ("chatScope" in input && input.chatScope === "group") return undefined;
  return input.chatId;
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
  try {
    const response = await dispatchTelegramInput(input, correlationId);
    if (!response.ok) {
      const retryable = response.error?.classification === "transient";
      await persistControllerLog({
        correlationId,
        component: "controller",
        operation: "telegramWebhook",
        stage: "worker",
        result: "failure",
        durationMs: Date.now() - started,
        code: response.error?.code ?? "WORKER_FAILED",
        ...(response.error?.diagnostic
          ? { metadata: response.error.diagnostic }
          : {}),
      });
      const chatId = privateChatId(input);
      if (
        !retryable &&
        chatId &&
        (await notifyTurnFailed(config.TELEGRAM_BOT_TOKEN, chatId))
      )
        return NextResponse.json({ ok: true }, { headers });
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
    return NextResponse.json({ ok: true }, { headers });
  } catch (error) {
    const failure = safeError(error, "INTERNAL_ERROR", "dispatch");
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
    const chatId = privateChatId(input);
    if (chatId && (await notifyTurnFailed(config.TELEGRAM_BOT_TOKEN, chatId)))
      return NextResponse.json({ ok: true }, { headers });
    return NextResponse.json({ ok: false }, { status: 503, headers });
  }
}
