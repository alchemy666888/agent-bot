export function chunkTelegramText(text: string, limit = 4096): string[] {
  if (!text) return [];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let at = rest.lastIndexOf("\n", limit);
    if (at < limit / 2) at = rest.lastIndexOf(" ", limit);
    if (at < 1) at = limit;
    chunks.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/**
 * Turn the small Markdown subset commonly returned by the model into readable
 * Telegram plain text. Sending plain text avoids leaking Markdown punctuation
 * when the model produces syntax that Telegram's parser does not accept.
 */
export function formatTelegramText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/^\s*```[^\n]*\n?/gm, "")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "│ ")
    .replace(/^(\s*)[-+*]\s+/gm, "$1• ")
    .replace(/^\s*(?:[-*_]\s*){3,}$/gm, "────────")
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(~~)(.*?)\1/g, "$2")
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1$2")
    .replace(/(^|[^_])_([^_\n]+)_(?!_)/g, "$1$2")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\\([_*#[\]()~`>+\-=|{}.!])/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export class TelegramClient {
  constructor(
    private token: string,
    private request: typeof fetch = fetch,
  ) {}
  private async call(method: string, body: unknown) {
    return this.request(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  async typing(chatId: string) {
    await this.call("sendChatAction", { chat_id: chatId, action: "typing" });
  }
  async acknowledgeCallback(callbackQueryId: string, text?: string) {
    const response = await this.call("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    });
    if (!response.ok) throw new Error("TELEGRAM_DELIVERY_FAILED");
  }
  async send(
    chatId: string,
    text: string,
    buttons?: readonly { text: string; callbackData: string }[],
    replyToMessageId?: string,
  ) {
    const formatted = formatTelegramText(text);
    const chunks = chunkTelegramText(formatted);
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index]!;
      const response = await this.call("sendMessage", {
        chat_id: chatId,
        text: chunk,
        ...(index === 0 && replyToMessageId
          ? { reply_parameters: { message_id: Number(replyToMessageId) } }
          : {}),
        ...(buttons?.length
          ? {
              reply_markup: {
                inline_keyboard: [
                  buttons.map((button) => ({
                    text: button.text,
                    callback_data: button.callbackData,
                  })),
                ],
              },
            }
          : {}),
      });
      if (!response.ok) throw new Error("TELEGRAM_DELIVERY_FAILED");
    }
  }
}
