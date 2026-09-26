import { defineConfig, devices } from "@playwright/test";
import {
  DASHBOARD_SECRET,
  E2E_ROOT,
  SESSION_SIGNING_SECRET,
} from "./tests/e2e/constants";

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  workers: 1,
  timeout: 60_000,
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "on-first-retry",
    channel: "chrome",
    launchOptions: { args: ["--no-sandbox", "--disable-dev-shm-usage"] },
  },
  webServer: {
    command: "pnpm build && pnpm exec next start --port 3000",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      ...process.env,
      DASHBOARD_SECRET,
      SESSION_SIGNING_SECRET,
      APP_URL: "http://127.0.0.1:3000",
      SANDBOX_DRIVE_NAME: "e2e-drive",
      SANDBOX_NAME: "e2e-sandbox",
      TELEGRAM_AGENT_LOCAL_ROOT: E2E_ROOT,
    },
  },
  projects: [
    {
      name: "chrome",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
      },
    },
  ],
});
