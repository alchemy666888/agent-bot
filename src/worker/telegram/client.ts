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
  async send(chatId: string, text: string) {
    for (const chunk of chunkTelegramText(text)) {
      let response = await this.call("sendMessage", {
        chat_id: chatId,
        text: chunk,
        parse_mode: "MarkdownV2",
      });
      if (!response.ok)
        response = await this.call("sendMessage", {
          chat_id: chatId,
          text: chunk,
        });
      if (!response.ok) throw new Error("TELEGRAM_DELIVERY_FAILED");
    }
  }
}
