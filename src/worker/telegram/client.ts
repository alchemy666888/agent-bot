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

function isMarkdownTableRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return false;
  const pipes = trimmed.split("|").length - 1;
  return trimmed.startsWith("|") || pipes >= 2;
}

function splitTableCells(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  const cells: string[] = [];
  let current = "";
  for (let index = 0; index < trimmed.length; index++) {
    const char = trimmed[index];
    if (char === "\\" && trimmed[index + 1] === "|") {
      current += "|";
      index++;
    } else if (char === "|") {
      cells.push(current.trim());
      current = "";
    } else current += char;
  }
  cells.push(current.trim());
  return cells;
}

function isTableSeparator(cells: readonly string[]): boolean {
  return (
    cells.length >= 2 && cells.every((cell) => /^:?-+:?$/.test(cell.trim()))
  );
}

function labelValue(label: string, value: string): string {
  const colon = /[\u3400-\u9fff]/.test(label) ? "：" : ": ";
  return `${label}${colon}${value}`;
}

/** Telegram plain text shows pipe tables literally. Rewrite a GFM table as one block per row. */
function renderMarkdownTable(block: readonly string[]): string | null {
  const parsed = block.map(splitTableCells);
  const separatorAt = parsed.findIndex(isTableSeparator);
  if (separatorAt < 0) return null;
  const header = separatorAt > 0 ? parsed[separatorAt - 1]! : [];
  const data = parsed.filter(
    (_, index) =>
      index !== separatorAt && !(separatorAt > 0 && index === separatorAt - 1),
  );
  if (data.length === 0) {
    const labels = header.filter(Boolean);
    return labels.length > 0 ? labels.join(" · ") : null;
  }
  const sections = data
    .map((row) => {
      const title = (row[0] ?? "").replace(/<br\s*\/?>/gi, " ").trim();
      const fields: string[] = [];
      const width = Math.max(header.length, row.length);
      for (let column = 1; column < width; column++) {
        const value = (row[column] ?? "").replace(/<br\s*\/?>/gi, " ").trim();
        if (!value) continue;
        const label = (header[column] ?? "").trim();
        fields.push(label ? labelValue(label, value) : value);
      }
      if (!title && fields.length === 0) return "";
      if (fields.length === 0) return title;
      if (!title) return fields.join("\n");
      return [title, ...fields].join("\n");
    })
    .filter(Boolean);
  return sections.length > 0 ? sections.join("\n\n") : null;
}

function convertMarkdownTables(text: string): string {
  const lines = text.split("\n");
  const output: string[] = [];
  let index = 0;
  while (index < lines.length) {
    if (!isMarkdownTableRow(lines[index]!)) {
      output.push(lines[index]!);
      index++;
      continue;
    }
    const block: string[] = [];
    while (index < lines.length && isMarkdownTableRow(lines[index]!)) {
      block.push(lines[index]!);
      index++;
    }
    output.push(renderMarkdownTable(block) ?? block.join("\n"));
  }
  return output.join("\n");
}

const SUMMARY_HEADING = /^四[、.．]\s*一句話總結/;
const NEXT_SECTION = /^(?:[一二三四五六七八九十]+|[0-9]{1,2})[、.．]/;

/** Drop a leading blockquote or table bar from one line. */
function stripLeadingBar(line: string): string {
  return line.replace(/^[ \t]*[|│]\s?/, "");
}

/**
 * The one-sentence summary is often wrapped in a quote or a one-column table.
 * Those bars are noise in that section; leave the same markers elsewhere.
 */
function stripSummarySectionBars(text: string): string {
  let inSummary = false;
  return text
    .split("\n")
    .map((line) => {
      const bare = stripLeadingBar(line).trim();
      if (!inSummary && SUMMARY_HEADING.test(bare)) {
        inSummary = true;
        return stripLeadingBar(line);
      }
      if (inSummary && NEXT_SECTION.test(bare) && !SUMMARY_HEADING.test(bare)) {
        inSummary = false;
        return line;
      }
      return inSummary ? stripLeadingBar(line) : line;
    })
    .join("\n");
}

/**
 * Turn the small Markdown subset commonly returned by the model into readable
 * Telegram plain text. Sending plain text avoids leaking Markdown punctuation
 * when the model produces syntax that Telegram's parser does not accept.
 */
export function formatTelegramText(text: string): string {
  const formatted = convertMarkdownTables(text.replace(/\r\n?/g, "\n"))
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
    .replace(/\n{3,}/g, "\n\n");
  return stripSummarySectionBars(formatted).trim();
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
