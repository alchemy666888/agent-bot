import { afterEach, describe, expect, it } from "vitest";
import { GET } from "../../../src/app/api/health/route";

const original = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, original);
});

describe("health route", () => {
  it("fails closed with only safe component states", async () => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    const response = GET();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      status: "degraded",
      components: {
        model: "degraded",
        telegram: "degraded",
        dashboard: "degraded",
        sandbox: "degraded",
        googleDrive: "degraded",
      },
    });
  });

  it("reports readiness without exposing configuration values", async () => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, {
      DEEPSEEK_API_KEY: "model-secret",
      DEEPSEEK_INPUT_PRICE_PER_MILLION: "1",
      DEEPSEEK_OUTPUT_PRICE_PER_MILLION: "2",
      TELEGRAM_BOT_TOKEN: "telegram-secret",
      TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
      DASHBOARD_SECRET: "dashboard-secret",
      SESSION_SIGNING_SECRET: "signing-secret",
      APP_URL: "https://example.test",
      SANDBOX_NAME: "sandbox-name",
      GOOGLE_DRIVE_FOLDER_ID: "1cMXhFmW-bV_JHRRv56ajhWADpM-i-3Wo",
      GOOGLE_CLIENT_ID: "client-id",
      GOOGLE_CLIENT_SECRET: "client-value",
      GOOGLE_REFRESH_TOKEN: "refresh-value",
    });
    const response = GET();
    const body = JSON.stringify(await response.json());
    expect(response.status).toBe(200);
    expect(body).toContain('"status":"ready"');
    expect(body).not.toMatch(/secret|drive-name|sandbox-name|sin1/);
  });
});
