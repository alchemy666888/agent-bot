import { describe, expect, it, vi } from "vitest";
import { TelegramClient } from "../../../../src/worker/telegram/client";

describe("Telegram client", () => {
  it("fails a send that ignores its deadline", async () => {
    let release: (() => void) | undefined;
    const request = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(new Response(JSON.stringify({ ok: true })));
        }),
    );
    const client = new TelegramClient("token", request as typeof fetch, 30);
    await expect(client.send("3", "hello")).rejects.toThrow(
      "TELEGRAM_DELIVERY_FAILED",
    );
    release?.();
  });
});
