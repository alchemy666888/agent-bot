import "server-only";

import { readDirectModelConfig, readTelegramConfig } from "../config";
import { uuidV7 } from "../../shared/ids";
import type { WorkerResponse } from "../../shared/contracts/worker";
import { deadline, settleOnAbort } from "../../shared/abort";
import { PROVIDER_REQUEST_TIMEOUT_MS } from "../../shared/worker-budget";
import { assistantTimeZone } from "../../shared/calendar-clock";
import { DeepSeekProvider } from "../../worker/model/deepseek";
import { cleanReplyBoilerplate } from "../../worker/model/reply-style";
import { TelegramClient } from "../../worker/telegram/client";
import { TELEGRAM_ACCESS_DENIED_TEXT, telegramUpdateAllowed } from "./access";
import type { TelegramInput } from "./input";

const UPDATE_TTL_MS = 10 * 60_000;
const MAX_RECENT_UPDATES = 1_000;
const DIRECT_CHAT_GUIDANCE =
  "Answer the current message independently. No conversation history or action tools are available. Do not claim to remember previous messages, save information, create schedules, or perform external actions.";
const recentUpdates = new Map<
  string,
  { expiresAt: number; result: Promise<WorkerResponse> }
>();

/** Best-effort replay protection within one server instance, without persistence. */
function once(updateId: string, action: () => Promise<WorkerResponse>) {
  const now = Date.now();
  for (const [id, entry] of recentUpdates)
    if (entry.expiresAt <= now) recentUpdates.delete(id);
  const existing = recentUpdates.get(updateId);
  if (existing) return existing.result;
  if (recentUpdates.size >= MAX_RECENT_UPDATES)
    recentUpdates.delete(recentUpdates.keys().next().value!);
  const result = action().catch((error: unknown) => {
    recentUpdates.delete(updateId);
    throw error;
  });
  recentUpdates.set(updateId, { expiresAt: now + UPDATE_TTL_MS, result });
  return result;
}

export function resetTelegramUpdates(): void {
  recentUpdates.clear();
}

/** Stateless Telegram → DeepSeek → Telegram. No worker, database, or repository reads. */
export async function dispatchTelegramInput(
  input: TelegramInput,
  correlationId = uuidV7(),
): Promise<WorkerResponse> {
  const accepted: WorkerResponse = {
    contractVersion: 1,
    correlationId,
    ok: true,
    data: { acknowledged: true },
  };
  if (
    input.kind === "ignored" ||
    (input.kind === "text" && input.chatScope === "group") ||
    ("chatId" in input && input.chatId.startsWith("-"))
  )
    return accepted;

  const telegram = readTelegramConfig();
  const client = new TelegramClient(telegram.TELEGRAM_BOT_TOKEN);
  if (!telegramUpdateAllowed(telegram.ALLOW_USERS, input)) {
    await client.send(input.chatId, TELEGRAM_ACCESS_DENIED_TEXT);
    if (input.kind === "callback")
      await client.acknowledgeCallback(input.callbackQueryId);
    return accepted;
  }
  if (input.kind === "callback") {
    await client.acknowledgeCallback(input.callbackQueryId);
    return accepted;
  }
  if (input.kind === "unsupported") {
    await client.send(input.chatId, "Please send a text message.");
    return accepted;
  }

  return once(input.updateId, async () => {
    const model = readDirectModelConfig();
    const provider = new DeepSeekProvider({
      apiKey: model.DEEPSEEK_API_KEY,
      baseUrl: model.DEEPSEEK_BASE_URL,
      thinking: model.DEEPSEEK_THINKING_ENABLED,
      maxToolCalls: 0,
      timeZone: assistantTimeZone(),
    });
    // The whole generation, including any output recovery, shares one cap.
    const cap = deadline(PROVIDER_REQUEST_TIMEOUT_MS);
    // Telegram expires chat actions after five seconds. Keep refreshing while
    // working, but never let this best-effort UI delay or fail the reply.
    const typing = () =>
      void client.typing(input.chatId).catch(() => undefined);
    typing();
    const typingRefresh = setInterval(typing, 4_000);
    try {
      const generated = await settleOnAbort(
        provider.generate({
          executionMode: "direct",
          messages: [
            {
              role: "system",
              content: `${model.ASSISTANT_SYSTEM_PROMPT}\n\n${DIRECT_CHAT_GUIDANCE}`,
            },
            { role: "user", content: input.text },
          ],
          signal: cap.signal,
        }),
        cap.signal,
      );
      const answer = cleanReplyBoilerplate(generated.content);
      if (!answer.trim()) throw new Error("ASSISTANT_RESPONSE_MISSING");
      await client.send(
        input.chatId,
        answer,
        undefined,
        input.replyToMessageId,
      );
      return accepted;
    } finally {
      clearInterval(typingRefresh);
      cap.cancel();
    }
  });
}
