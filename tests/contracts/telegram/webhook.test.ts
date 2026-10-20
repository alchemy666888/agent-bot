import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

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

import { resetWebhookFailureClaims } from "../../../src/app/api/telegram/webhook/failure-ack";
import {
  POST,
  WEBHOOK_ACK_MS,
} from "../../../src/app/api/telegram/webhook/route";

const request = (body: unknown, secret = "fixture-secret") =>
  new Request("https://example.test/api/telegram/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": secret,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const privateText = (updateId: number, text = "hello") => ({
  update_id: updateId,
  message: {
    message_id: 3,
    chat: { id: 4, type: "private" },
    from: { id: 5, username: "duck" },
    text,
  },
});

async function flushMicrotasks(): Promise<void> {
  for (let step = 0; step < 20; step++) await Promise.resolve();
}

describe("Telegram webhook", () => {
  beforeEach(() => {
    resetWebhookFailureClaims();
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
    expect(dispatchTelegramInput).toHaveBeenCalledWith(
      {
        kind: "text",
        updateId: "1",
        messageId: "2",
        chatId: "3",
        userId: "4",
        username: "public-name",
        languageCode: undefined,
        text: "hello",
      },
      expect.stringMatching(/^[0-9a-f-]{36}$/),
    );
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

  it("tells a private chat when dispatch throws and does not ask Telegram to retry", async () => {
    dispatchTelegramInput.mockRejectedValueOnce(
      new Error("SANDBOX_UNAVAILABLE"),
    );
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const response = await POST(
        request({
          update_id: 2,
          message: {
            message_id: 3,
            chat: { id: 4, type: "private" },
            from: { id: 5, username: "duck" },
            text: "hello",
          },
        }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
      expect(body).toMatchObject({
        chat_id: "4",
        text: expect.stringContaining("這次回覆沒有完成，請再傳一次。"),
      });
      expect(body.text).toContain("source: dispatch");
      expect(body.text).toContain("code: SANDBOX_UNAVAILABLE");
      expect(body.text).toContain("updateId: 2");
      expect(body.text).toContain("inputKind: text");
      expect(body.text).toContain("detail:");
      expect(body.text).toContain("trace:");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("adds the worker progress to a private timeout message", async () => {
    dispatchTelegramInput.mockRejectedValueOnce(
      Object.assign(new Error("WORKER_COMMAND_TIMEOUT"), {
        operation: "telegramTurn",
        timeoutLimitMs: 250_000,
        progress: {
          stage: "model",
          elapsedMs: 248_000,
          iteration: 1,
          executionMode: "forced_web_search",
          tool: "web_search",
        },
      }),
    );
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const response = await POST(request(privateText(21)));
      expect(response.status).toBe(200);
      const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
      expect(body.text).toContain("code: WORKER_COMMAND_TIMEOUT");
      expect(body.text).toContain("classification: transient");
      expect(body.text).toContain("operation: telegramTurn");
      expect(body.text).toContain("timeoutLimitMs: 250000");
      expect(body.text).toContain("workerStage: model");
      expect(body.text).toContain("workerElapsedMs: 248000");
      expect(body.text).toContain("executionMode: forced_web_search");
      expect(body.text).toContain("tool: web_search");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("accepts a transient private failure without asking Telegram to retry", async () => {
    dispatchTelegramInput.mockResolvedValueOnce({
      contractVersion: 1,
      correlationId: "0199-ignored-in-mock",
      ok: false,
      error: {
        code: "DEEPSEEK_REQUEST_FAILED",
        classification: "transient",
        message: "Temporary operation failure",
      },
    });
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const response = await POST(request(privateText(8)));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
      expect(body.text).toContain("這次回覆沒有完成，請再傳一次。");
      expect(body.text).toContain("source: worker");
      expect(body.text).toContain("code: DEEPSEEK_REQUEST_FAILED");
      expect(body.text).toContain("classification: transient");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps a transient failure retryable when there is no private chat to notify", async () => {
    dispatchTelegramInput.mockResolvedValueOnce({
      contractVersion: 1,
      correlationId: "0199-ignored-in-mock",
      ok: false,
      error: {
        code: "DEEPSEEK_REQUEST_FAILED",
        classification: "transient",
        message: "Temporary operation failure",
      },
    });
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const response = await POST(
        request({ update_id: 2, edited_message: {} }),
      );
      expect(response.status).toBe(503);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns 200 before a slow private turn finishes and notifies only if it fails", async () => {
    let rejectDispatch: (error: Error) => void = () => undefined;
    dispatchTelegramInput.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectDispatch = reject;
      }),
    );
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = POST(request(privateText(11)));
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(WEBHOOK_ACK_MS);
      const response = await pending;
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(fetchMock).not.toHaveBeenCalled();
      rejectDispatch(new Error("SANDBOX_UNAVAILABLE"));
      await flushMicrotasks();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
      expect(body.text).toContain("這次回覆沒有完成，請再傳一次。");
      expect(body.text).toContain("code: SANDBOX_UNAVAILABLE");
      expect(body.text).toContain("source: dispatch");
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("does not send a failure notice when a slow private turn succeeds", async () => {
    let resolveDispatch: (response: {
      contractVersion: 1;
      correlationId: string;
      ok: true;
      data: Record<string, never>;
    }) => void = () => undefined;
    dispatchTelegramInput.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveDispatch = resolve;
      }),
    );
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = POST(request(privateText(13)));
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(WEBHOOK_ACK_MS);
      const response = await pending;
      expect(response.status).toBe(200);
      resolveDispatch({
        contractVersion: 1,
        correlationId: "0199-ignored-in-mock",
        ok: true,
        data: {},
      });
      await flushMicrotasks();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("sends the failure notice on the next delivery when Telegram rejects it", async () => {
    dispatchTelegramInput.mockRejectedValue(new Error("SANDBOX_UNAVAILABLE"));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 500 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const first = await POST(request(privateText(14)));
      const second = await POST(request(privateText(14)));
      expect(first.status).toBe(503);
      expect(second.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not send the failure notice again for the same update", async () => {
    dispatchTelegramInput.mockRejectedValue(new Error("SANDBOX_UNAVAILABLE"));
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const first = await POST(request(privateText(12)));
      const second = await POST(request(privateText(12, "again")));
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(dispatchTelegramInput).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("tells a private chat when the worker reports a permanent failure", async () => {
    dispatchTelegramInput.mockResolvedValueOnce({
      contractVersion: 1,
      correlationId: "0199-ignored-in-mock",
      ok: false,
      error: {
        code: "WORKER_CONFIGURATION_INVALID",
        classification: "permanent",
        message: "Operation failed",
      },
    });
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const response = await POST(
        request({
          update_id: 2,
          message: {
            message_id: 3,
            chat: { id: 4, type: "private" },
            from: { id: 5 },
            text: "hello",
          },
        }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
      expect(body.text).toContain("這次回覆沒有完成，請再傳一次。");
      expect(body.text).toContain("code: WORKER_CONFIGURATION_INVALID");
      expect(body.text).toContain("classification: permanent");
      expect(body.text).toContain("source: worker");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("omits secrets from the private failure notice", async () => {
    dispatchTelegramInput.mockRejectedValueOnce(
      new Error("Bearer sk-abcdefghijklmnopqrstuvwxyz012345"),
    );
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const response = await POST(request(privateText(16)));
      expect(response.status).toBe(200);
      const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
      expect(body.text).toContain("這次回覆沒有完成，請再傳一次。");
      expect(body.text).toContain("[REDACTED]");
      expect(body.text).not.toMatch(/sk-|abcdefghijklmnopqrstuvwxyz/i);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("logs configuration field names when dispatch fails before any request", async () => {
    let failure: unknown;
    try {
      z.object({ DEEPSEEK_BASE_URL: z.string().url() }).parse({
        DEEPSEEK_BASE_URL: "",
      });
    } catch (error) {
      failure = error;
    }
    dispatchTelegramInput.mockRejectedValueOnce(failure);
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const response = await POST(request({ update_id: 2, edited_message: {} }));

    expect(response.status).toBe(503);
    const event = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(event).toMatchObject({
      operation: "telegramWebhook",
      stage: "dispatch",
      result: "failure",
      code: "CONFIGURATION_INVALID",
      metadata: { issues: ["DEEPSEEK_BASE_URL:invalid_format"] },
    });
    log.mockRestore();
  });

  it("returns a non-retryable failure reported by the worker", async () => {
    dispatchTelegramInput.mockResolvedValueOnce({
      contractVersion: 1,
      correlationId: "0199-ignored-in-mock",
      ok: false,
      error: {
        code: "WORKER_CONFIGURATION_INVALID",
        classification: "permanent",
        message: "Operation failed",
        diagnostic: {
          stage: "operation",
          kind: "TypeError",
          causeCode: "ERR_INVALID_ARG_TYPE",
        },
      },
    });
    const response = await POST(request({ update_id: 2, edited_message: {} }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false });
  });

  it("rejects malformed JSON without dispatching", async () => {
    const response = await POST(request("{"));
    expect(response.status).toBe(400);
    expect(dispatchTelegramInput).not.toHaveBeenCalled();
  });
});
