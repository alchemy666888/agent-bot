import { beforeEach, describe, expect, it, vi } from "vitest";

const { dispatchTelegramInput } = vi.hoisted(() => ({
  dispatchTelegramInput: vi.fn(),
}));

vi.mock("../../../src/server/config", () => ({
  readTelegramConfig: () => ({
    TELEGRAM_BOT_TOKEN: "fixture-token",
    TELEGRAM_WEBHOOK_SECRET: "fixture-secret",
  }),
}));
vi.mock("../../../src/server/telegram/dispatch", () => ({
  dispatchTelegramInput,
}));

import { POST } from "../../../src/app/api/telegram/webhook/route";

const request = (body: unknown, secret = "fixture-secret") =>
  new Request("https://example.test/api/telegram/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": secret,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("Telegram webhook", () => {
  beforeEach(() => {
    dispatchTelegramInput.mockReset();
    dispatchTelegramInput.mockResolvedValue({
      contractVersion: 1,
      correlationId: "0199-ignored-in-mock",
      ok: true,
      data: {},
    });
  });

  it("rejects the wrong secret before parsing or dispatching", async () => {
    const response = await POST(request("not-json", "wrong"));
    expect(response.status).toBe(401);
    expect(dispatchTelegramInput).not.toHaveBeenCalled();
  });

  it("dispatches only minimized private text fields", async () => {
    const response = await POST(
      request({
        update_id: 1,
        secretRawField: "must-not-pass",
        message: {
          message_id: 2,
          chat: { id: 3, type: "private" },
          from: { id: 4, first_name: "Private", username: "public-name" },
          text: "hello",
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(dispatchTelegramInput).toHaveBeenCalledWith({
      kind: "text",
      updateId: "1",
      messageId: "2",
      chatId: "3",
      userId: "4",
      username: "public-name",
      languageCode: undefined,
      text: "hello",
    });
    expect(JSON.stringify(dispatchTelegramInput.mock.calls)).not.toContain(
      "must-not-pass",
    );
    expect(JSON.stringify(dispatchTelegramInput.mock.calls)).not.toContain(
      "Private",
    );
  });

  it("returns retryable failure when worker dispatch throws", async () => {
    dispatchTelegramInput.mockRejectedValueOnce(new Error("private detail"));
    const response = await POST(request({ update_id: 2, edited_message: {} }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false });
  });

  it("rejects malformed JSON without dispatching", async () => {
    const response = await POST(request("{"));
    expect(response.status).toBe(400);
    expect(dispatchTelegramInput).not.toHaveBeenCalled();
  });
});
