import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const afterTasks = vi.hoisted(() => [] as Array<() => Promise<void>>);
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: () => Promise<void>) => afterTasks.push(task),
}));

const databaseAccess = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("The Telegram webhook must never access PostgreSQL");
  }),
);
vi.mock("pg", () => ({
  Pool: class {
    constructor() {
      databaseAccess();
    }
  },
}));
vi.mock("../../../src/shared/postgres/controller-log", () => ({
  openPersistenceStore: databaseAccess,
  persistControllerLog: databaseAccess,
}));

import {
  POST,
  WEBHOOK_ACK_MS,
} from "../../../src/app/api/telegram/webhook/route";
import { resetWebhookFailureClaims } from "../../../src/app/api/telegram/webhook/failure-ack";
import { resetTelegramUpdates } from "../../../src/server/telegram/dispatch";
import { DIRECT_GENERATION_TIMEOUT_MS } from "../../../src/shared/worker-budget";

const fetchMock = vi.fn<typeof fetch>();
const request = () =>
  new Request("https://example.test/api/telegram/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": "secret",
    },
    body: JSON.stringify({
      update_id: 11,
      message: {
        message_id: 12,
        chat: { id: 42, type: "private" },
        from: { id: 42 },
        text: "CPI數據出來了，BTC有沒有交易機會",
      },
    }),
  });

describe("direct Telegram webhook without persistence", () => {
  beforeEach(() => {
    resetTelegramUpdates();
    afterTasks.length = 0;
    resetWebhookFailureClaims();
    databaseAccess.mockClear();
    for (const [key, value] of Object.entries({
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_WEBHOOK_SECRET: "secret",
      DEEPSEEK_API_KEY: "key",
      DEEPSEEK_BASE_URL: "https://deepseek.test",
      ALLOW_USERS: "42",
      DATABASE_URL: "postgres://unreachable.invalid/app",
      // The former failure-ack implementation bypassed storage under Vitest.
      // Disable that shortcut so these tests cover production behavior.
      VITEST: "",
    }))
      vi.stubEnv(key, value);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url) =>
      String(url) === "https://deepseek.test/responses"
        ? Response.json({
            output: [
              { type: "web_search_call", id: "ws", status: "completed" },
            ],
            output_text: "請提供 CPI 實際值與預期值。",
          })
        : Response.json({ ok: true }),
    );
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    expect(databaseAccess).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("authenticates, calls DeepSeek, and replies without storage or other APIs", async () => {
    const response = await POST(request());
    const modelRequest = JSON.parse(String(fetchMock.mock.calls[1]![1]!.body));
    expect(modelRequest.model).toBe("deepseek-v4-pro");
    expect(modelRequest.tools).toEqual([{ type: "web_search" }]);
    expect(modelRequest.tool_choice).toBe("auto");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.telegram.org/bottoken/sendChatAction",
      "https://deepseek.test/responses",
      "https://api.telegram.org/bottoken/sendMessage",
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[2]![1]!.body))).toMatchObject(
      {
        chat_id: "42",
        text: "請提供 CPI 實際值與預期值。",
      },
    );
    await POST(request());
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("reports a provider failure once, including replay, without database logs or claims", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ ok: true }));
    fetchMock.mockResolvedValueOnce(
      Response.json({ error: { message: "Unavailable" } }, { status: 503 }),
    );
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(JSON.parse(String(fetchMock.mock.calls[2]![1]!.body)).text).toBe(
      "這次回覆沒有完成，請再傳一次。",
    );
    await POST(request());
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("bounds a stalled provider and sends the failure notice after the early acknowledgement", async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fetchMock.mockImplementation(async (url) =>
      String(url) === "https://deepseek.test/responses"
        ? new Promise<Response>(() => undefined)
        : Response.json({ ok: true }),
    );
    const pending = POST(request());
    await vi.advanceTimersByTimeAsync(WEBHOOK_ACK_MS);
    expect((await pending).status).toBe(200);
    expect(afterTasks).toHaveLength(1);
    const background = afterTasks[0]!();
    const modelCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("deepseek.test"),
    );
    expect(modelCall![1]!.signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(
      DIRECT_GENERATION_TIMEOUT_MS - WEBHOOK_ACK_MS + 1,
    );
    await background;
    expect(modelCall![1]!.signal!.aborted).toBe(true);
    expect(JSON.parse(String(fetchMock.mock.calls.at(-1)![1]!.body)).text).toBe(
      "這次回覆沒有完成，請再傳一次。",
    );
    const records = log.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(records).toContainEqual(
      expect.objectContaining({
        operation: "deepseek.responses",
        code: "PROVIDER_REQUEST_TIMEOUT",
        stage: "response-headers",
        metadata: expect.objectContaining({
          model: "deepseek-v4-pro",
          timeoutLimitMs: 120_000,
          timeoutSource: "generation",
        }),
      }),
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        operation: "telegramWebhook",
        metadata: expect.objectContaining({
          error: expect.objectContaining({ classification: "transient" }),
        }),
      }),
    );
    await POST(request());
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith("/sendMessage"),
      ),
    ).toHaveLength(1);
  });

  it("acknowledges promptly and delivers a response taking longer than 45 seconds", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async (url) =>
      String(url) === "https://deepseek.test/responses"
        ? new Promise<Response>((resolve) =>
            setTimeout(
              () =>
                resolve(
                  Response.json(
                    { output_text: "A completed answer", id: "resp-123" },
                    { headers: { "x-request-id": "req-123" } },
                  ),
                ),
              60_000,
            ),
          )
        : Response.json({ ok: true }),
    );
    const pending = POST(request());
    await vi.advanceTimersByTimeAsync(WEBHOOK_ACK_MS);
    expect((await pending).status).toBe(200);
    expect(afterTasks).toHaveLength(1);
    const background = afterTasks[0]!();
    await vi.advanceTimersByTimeAsync(44_001);
    const modelCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("deepseek.test"),
    )!;
    expect(modelCall[1]!.signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(15_000);
    await background;
    expect(JSON.parse(String(fetchMock.mock.calls.at(-1)![1]!.body)).text).toBe(
      "A completed answer",
    );
    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining('"providerRequestId":"req-123"'),
    );
    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining('"bodyCompleteMs":60000'),
    );
  });

  it("keeps recovery inside the original generation budget", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let exchanges = 0;
    fetchMock.mockImplementation(async (url) => {
      if (String(url) !== "https://deepseek.test/responses")
        return Response.json({ ok: true });
      exchanges++;
      return exchanges === 1
        ? new Promise<Response>((resolve) =>
            setTimeout(() => resolve(Response.json({ output: [] })), 80_000),
          )
        : new Promise<Response>(() => undefined);
    });
    const pending = POST(request());
    await vi.advanceTimersByTimeAsync(WEBHOOK_ACK_MS);
    expect((await pending).status).toBe(200);
    const background = afterTasks[0]!();
    await vi.advanceTimersByTimeAsync(80_000 - WEBHOOK_ACK_MS);
    expect(exchanges).toBe(2);
    await vi.advanceTimersByTimeAsync(40_001);
    await background;
    const calls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("deepseek.test"),
    );
    expect(calls[1]![1]!.signal!.aborted).toBe(true);
    expect(JSON.parse(String(fetchMock.mock.calls.at(-1)![1]!.body)).text).toBe(
      "這次回覆沒有完成，請再傳一次。",
    );
  });
});
