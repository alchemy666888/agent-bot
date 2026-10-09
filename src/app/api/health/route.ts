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
    model: valid(readModelConfig),
    telegram: valid(readTelegramConfig),
    dashboard: valid(readDashboardConfig),
    sandbox: valid(readSandboxConfig),
    postgres: valid(readDatabaseConfig),
    newsMcp: valid(readNewsMcpConfig),
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
  } catch {
    return "degraded";
  }
}

function valid(reader: () => unknown): "ready" | "degraded" {
  try {
    reader();
    return "ready";
  } catch {
    return "degraded";
  }
}
