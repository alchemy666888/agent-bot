import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const databaseAccess = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("Telegram must not open a database");
  }),
);
vi.mock("pg", () => ({
  Pool: class {
    constructor() {
      databaseAccess();
    }
  },
}));

import { TELEGRAM_ACCESS_DENIED_TEXT } from "../../../../src/server/telegram/access";
import {
  dispatchTelegramInput,
  resetTelegramUpdates,
} from "../../../../src/server/telegram/dispatch";

const input = {
  kind: "text" as const,
  updateId: "1",
  messageId: "2",
  chatId: "3",
  userId: "4",
  text: "CPI數據出來了，BTC有沒有交易機會",
};
const fetchMock = vi.fn<typeof fetch>();

describe("stateless Telegram dispatch", () => {
  beforeEach(() => {
    resetTelegramUpdates();
    databaseAccess.mockClear();
    for (const [key, value] of Object.entries({
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_WEBHOOK_SECRET: "secret",
      DEEPSEEK_API_KEY: "key",
      DEEPSEEK_BASE_URL: "https://deepseek.test",
      DEEPSEEK_THINKING_ENABLED: "false",
      ASSISTANT_SYSTEM_PROMPT: "Reply helpfully in the user's language.",
      ALLOW_USERS: "4",
      // Even enabled legacy features and invalid storage configuration cannot
      // capture the direct path or require a database/repository connection.
      DATABASE_URL: "must-not-be-parsed",
      AIVEN_PG_CA: "invalid-certificate",
      PROMPT_READS_ENABLED: "true",
      SKILLS_ENABLED: "true",
      DEEPSEEK_ROUTING_ENABLED: "true",
      SANDBOX_NAME: "",
      NEWS_MCP_API_KEY: "invalid-key",
    }))
      vi.stubEnv(key, value);
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url) =>
      String(url) === "https://deepseek.test/responses"
        ? Response.json({
            output_text: "請提供 CPI 數據與 BTC 現價，我可以分析交易條件。",
          })
        : Response.json({ ok: true }),
    );
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    expect(databaseAccess).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("sends the current message directly to DeepSeek and delivers its answer", async () => {
    await expect(dispatchTelegramInput(input)).resolves.toMatchObject({
      ok: true,
    });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://deepseek.test/responses",
      "https://api.telegram.org/bottoken/sendMessage",
    ]);
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(body).toMatchObject({ model: "deepseek-v4-pro", stream: false });
    expect(body.input).toEqual([{ role: "user", content: input.text }]);
    expect(body.instructions).toContain(
      "Reply helpfully in the user's language.",
    );
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(body.instructions).not.toContain("must-not-be-parsed");
    const reply = JSON.parse(String(fetchMock.mock.calls[1]![1]!.body));
    expect(reply).toMatchObject({
      chat_id: "3",
      text: "請提供 CPI 數據與 BTC 現價，我可以分析交易條件。",
    });
  });

  it("does not include another message or user in subsequent model requests", async () => {
    await dispatchTelegramInput(input);
    await dispatchTelegramInput({
      ...input,
      updateId: "2",
      text: "第二個問題",
    });
    const body = JSON.parse(String(fetchMock.mock.calls[2]![1]!.body));
    expect(body.input).toEqual([{ role: "user", content: "第二個問題" }]);
    expect(JSON.stringify(body)).not.toContain(input.text);
  });

  it("coalesces concurrent and completed retries of the same update in memory", async () => {
    await Promise.all([
      dispatchTelegramInput(input),
      dispatchTelegramInput(input),
    ]);
    await dispatchTelegramInput(input);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("expires replay protection instead of retaining updates indefinitely", async () => {
    vi.useFakeTimers();
    await dispatchTelegramInput(input);
    vi.setSystemTime(Date.now() + 10 * 60_000 + 1);
    await dispatchTelegramInput(input);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("lets a failed update be retried without retrying the provider internally", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ error: { message: "Unavailable" } }, { status: 503 }),
    );
    await expect(dispatchTelegramInput(input)).rejects.toMatchObject({
      status: 503,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    await expect(dispatchTelegramInput(input)).resolves.toMatchObject({
      ok: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("checks the allowlist before sending any user message to DeepSeek", async () => {
    await dispatchTelegramInput({ ...input, userId: "5" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]![0])).toContain("api.telegram.org");
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)).text).toBe(
      TELEGRAM_ACCESS_DENIED_TEXT,
    );
  });

  it("ignores group messages and edits without contacting an API", async () => {
    await dispatchTelegramInput({ ...input, chatScope: "group" });
    await dispatchTelegramInput({ ...input, chatId: "-100123" });
    await dispatchTelegramInput({ kind: "ignored", updateId: "3" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("acknowledges old callback buttons without executing stored actions", async () => {
    await dispatchTelegramInput({
      kind: "callback",
      updateId: "4",
      messageId: "2",
      chatId: "3",
      userId: "4",
      callbackQueryId: "callback",
      data: "opaque-capability",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]![0])).toContain(
      "answerCallbackQuery",
    );
  });

  it("answers unsupported media without invoking DeepSeek", async () => {
    await dispatchTelegramInput({
      kind: "unsupported",
      updateId: "5",
      chatId: "3",
      userId: "4",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)).text).toBe(
      "Please send a text message.",
    );
  });
});
