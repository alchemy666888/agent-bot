import { describe, expect, it } from "vitest";

import {
  GOOGLE_DRIVE_FOLDER_ID,
  googleDriveProcessEnv,
  readGoogleDriveConfig,
} from "../../src/shared/google-drive/config";
import {
  DEFAULT_SYSTEM_PROMPT,
  readDashboardConfig,
  readModelConfig,
  readSandboxConfig,
  readTelegramConfig,
} from "../../src/server/config";

describe("entry-point configuration", () => {
  it("uses approved model defaults", () => {
    const config = readModelConfig({
      DEEPSEEK_API_KEY: "fixture-key",
      DEEPSEEK_INPUT_PRICE_PER_MILLION: "1.25",
      DEEPSEEK_OUTPUT_PRICE_PER_MILLION: "2.50",
    });
    expect(config).toMatchObject({
      ASSISTANT_SYSTEM_PROMPT: DEFAULT_SYSTEM_PROMPT,
      DEEPSEEK_THINKING_ENABLED: true,
      DEEPSEEK_REASONING_EFFORT: "medium",
      DEEPSEEK_BASE_URL: "https://api.deepseek.com",
    });
  });

  it.each([
    {},
    { TELEGRAM_BOT_TOKEN: "", TELEGRAM_WEBHOOK_SECRET: "ok" },
    { TELEGRAM_BOT_TOKEN: "ok", TELEGRAM_WEBHOOK_SECRET: "" },
  ])("rejects missing or empty Telegram settings", (env) => {
    expect(() => readTelegramConfig(env)).toThrow();
  });

  it.each(["TRUE", "yes", "1", ""])('rejects invalid boolean "%s"', (value) => {
    expect(() =>
      readModelConfig({
        DEEPSEEK_API_KEY: "fixture-key",
        DEEPSEEK_INPUT_PRICE_PER_MILLION: "1",
        DEEPSEEK_OUTPUT_PRICE_PER_MILLION: "1",
        DEEPSEEK_THINKING_ENABLED: value,
      }),
    ).toThrow();
  });

  it.each(["-1", "NaN", "free", ""])("rejects invalid price %s", (value) => {
    expect(() =>
      readModelConfig({
        DEEPSEEK_API_KEY: "fixture-key",
        DEEPSEEK_INPUT_PRICE_PER_MILLION: value,
        DEEPSEEK_OUTPUT_PRICE_PER_MILLION: "1",
      }),
    ).toThrow();
  });

  it("rejects a region other than sin1", () => {
    expect(() =>
      readSandboxConfig({
        SANDBOX_NAME: "fixture-sandbox",
        SANDBOX_REGION: "iad1",
      }),
    ).toThrow();
  });

  it("loads each entry point independently", () => {
    expect(
      readTelegramConfig({
        TELEGRAM_BOT_TOKEN: "token",
        TELEGRAM_WEBHOOK_SECRET: "secret",
      }),
    ).toBeTruthy();
    expect(
      readDashboardConfig({
        DASHBOARD_SECRET: "any non-empty value",
        SESSION_SIGNING_SECRET: "fixture-signing-secret",
        APP_URL: "https://example.test",
      }),
    ).toBeTruthy();
    expect(
      readSandboxConfig({
        SANDBOX_NAME: "sandbox",
      }).region,
    ).toBe("sin1");
    expect(
      readGoogleDriveConfig({
        GOOGLE_DRIVE_FOLDER_ID,
        GOOGLE_CLIENT_ID: "client",
        GOOGLE_CLIENT_SECRET: "client-value",
        GOOGLE_REFRESH_TOKEN: "refresh-value",
      }).GOOGLE_DRIVE_FOLDER_ID,
    ).toBe(GOOGLE_DRIVE_FOLDER_ID);
  });

  it("passes Drive credentials only when they are configured", () => {
    expect(googleDriveProcessEnv({})).toEqual({});
    expect(() => googleDriveProcessEnv({ VERCEL: "1" })).toThrow(
      "GOOGLE_DRIVE_CONFIGURATION_INVALID",
    );
  });

  it("rejects any Google Drive folder other than the configured one", () => {
    expect(() =>
      readGoogleDriveConfig({
        GOOGLE_DRIVE_FOLDER_ID: "different-folder",
        GOOGLE_CLIENT_ID: "client",
        GOOGLE_CLIENT_SECRET: "client-value",
        GOOGLE_REFRESH_TOKEN: "refresh-value",
      }),
    ).toThrow();
  });
});
