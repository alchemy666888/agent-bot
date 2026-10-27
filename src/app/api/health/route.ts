import { uuidV7 } from "../../../shared/ids";
import { logException } from "../../../shared/logger";
import {
  readDashboardConfig,
  readDatabaseConfig,
  readModelConfig,
  readNewsMcpConfig,
  readPromptConfig,
  readSandboxConfig,
  readTelegramConfig,
} from "../../../server/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "no-store" };

export function GET(): Response {
  const components = {
    model: valid(readModelConfig, "model"),
    telegram: valid(readTelegramConfig, "telegram"),
    dashboard: valid(readDashboardConfig, "dashboard"),
    sandbox: valid(readSandboxConfig, "sandbox"),
    postgres: valid(readDatabaseConfig, "postgres"),
    newsMcp: valid(readNewsMcpConfig, "newsMcp"),
    prompts: promptHealth(),
  } as const;
  const ready = Object.values(components).every(
    (state) => state === "ready" || state === "disabled",
  );
  return Response.json(
    { status: ready ? "ready" : "degraded", components },
    { status: ready ? 200 : 503, headers },
  );
}

/** Deliberately exposes compatibility states only, never repository identity or policy data. */
function promptHealth(): "disabled" | "ready" | "degraded" {
  try {
    const config = readPromptConfig();
    return config.PROMPT_READS_ENABLED ? "ready" : "disabled";
  } catch (error) {
    logHealthFailure(error, "prompts");
    return "degraded";
  }
}

function valid(reader: () => unknown, component: string): "ready" | "degraded" {
  try {
    reader();
    return "ready";
  } catch (error) {
    logHealthFailure(error, component);
    return "degraded";
  }
}

function logHealthFailure(error: unknown, component: string): void {
  logException(error, { correlationId: uuidV7(), component: "controller", operation: "health", stage: "configuration", metadata: { service: component } });
}
