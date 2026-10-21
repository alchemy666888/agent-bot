import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const repositoryAccess = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("Direct Telegram messages must not access schedules");
  }),
);
vi.mock("../../../src/shared/schedules/repository", () => ({
  postgresScheduleRepository: repositoryAccess,
}));
import {
  dispatchTelegramInput,
  resetTelegramUpdates,
} from "../../../src/server/telegram/dispatch";

const fetchMock = vi.fn<typeof fetch>();
describe("schedule text in direct Telegram chat", () => {
  beforeEach(() => {
    resetTelegramUpdates();
    repositoryAccess.mockClear();
    for (const [key, value] of Object.entries({
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_WEBHOOK_SECRET: "secret",
      DEEPSEEK_API_KEY: "key",
      DEEPSEEK_BASE_URL: "https://deepseek.test",
      ALLOW_USERS: "42",
      DATABASE_URL: "must-not-be-parsed",
    }))
      vi.stubEnv(key, value);
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url) =>
      String(url) === "https://deepseek.test/responses"
        ? Response.json({ output_text: "無法建立或讀取排程。" })
        : Response.json({ ok: true }),
    );
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each([
    "/schedules",
    "設定排程 每天 09:00 今日新聞",
    "/schedule_stop abcd1234",
  ])(
    "sends %s to DeepSeek without reading or changing schedules",
    async (text) => {
      await dispatchTelegramInput({
        kind: "text",
        updateId: "11",
        messageId: "12",
        chatId: "42",
        userId: "42",
        text,
      });
      expect(repositoryAccess).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
      expect(body.input).toEqual([{ role: "user", content: text }]);
      expect(body.instructions).toContain(
        "Do not claim to remember previous messages, save information, create schedules",
      );
    },
  );
});
