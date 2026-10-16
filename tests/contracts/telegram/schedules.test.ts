import { beforeEach, describe, expect, it, vi } from "vitest";

const repository = vi.hoisted(() => ({
  create: vi.fn(),
  listByOwner: vi.fn(),
  setStatus: vi.fn(),
}));
const fetchMock = vi.hoisted(() => vi.fn());

vi.mock("@vercel/connect", () => ({
  getToken: vi.fn(async () => "github-token"),
}));
vi.mock("../../../src/server/sandbox/controller", () => ({
  ensureSandbox: vi.fn(),
  resetSandbox: vi.fn(),
}));
vi.mock("../../../src/server/sandbox/transport", () => ({
  installWorker: vi.fn(),
  invokeWorker: vi.fn(),
}));
vi.mock("../../../src/shared/schedules/repository", () => ({
  postgresScheduleRepository: () => repository,
}));

import { invokeWorker } from "../../../src/server/sandbox/transport";
import { dispatchTelegramInput } from "../../../src/server/telegram/dispatch";

describe("Telegram schedule commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const [key, value] of Object.entries({
      SANDBOX_NAME: "test-sandbox",
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_WEBHOOK_SECRET: "secret",
      DEEPSEEK_API_KEY: "key",
      DEEPSEEK_INPUT_PRICE_PER_MILLION: "1",
      DEEPSEEK_OUTPUT_PRICE_PER_MILLION: "2",
      PROMPT_READS_ENABLED: "false",
      GITHUB_CONNECTOR: "github/skills-repo",
      GITHUB_SKILLS_OWNER: "alchemy666888",
      GITHUB_SKILLS_REPO: "skill",
      GITHUB_SKILLS_BRANCH: "main",
      DATABASE_URL: "postgres://user:pass@db.test/app",
      ALLOW_USERS: "42",
      NEWS_MCP_API_KEY: "",
      "NEWS-MCP-API-KEY": "",
    }))
      vi.stubEnv(key, value);
    repository.listByOwner.mockResolvedValue([]);
    repository.create.mockResolvedValue({
      ok: true,
      task: {
        publicId: "abcd1234",
        nextRunAt: new Date("2026-10-14T01:00:00.000Z"),
      },
    });
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  it("lists schedules without invoking the worker", async () => {
    const response = await dispatchTelegramInput({
      kind: "text",
      updateId: "11",
      messageId: "12",
      chatId: "42",
      userId: "42",
      text: "/schedules",
    });
    expect(response.ok).toBe(true);
    expect(invokeWorker).not.toHaveBeenCalled();
    expect(repository.listByOwner).toHaveBeenCalledWith("42");
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.text).toMatch(/no schedules/i);
  });

  it("stores a Chinese schedule request and replies to that chat", async () => {
    const text = "設定排程 每天 09:00 今日新聞";
    await dispatchTelegramInput({
      kind: "text",
      updateId: "21",
      messageId: "22",
      chatId: "42",
      userId: "42",
      languageCode: "zh-Hant",
      text,
    });
    expect(invokeWorker).not.toHaveBeenCalled();
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerTelegramUserId: "42",
        chatId: "42",
        sourceMessage: text,
        userPrompt: "今日新聞",
        metadata: expect.objectContaining({
          schedule: { kind: "daily", hour: 9, minute: 0 },
          replyLocale: "zh",
          sourceMessageId: "22",
        }),
      }),
    );
  });
});
