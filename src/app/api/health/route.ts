import {
  readDashboardConfig,
  readModelConfig,
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
  } as const;
  const ready = Object.values(components).every((state) => state === "ready");
  return Response.json(
    { status: ready ? "ready" : "degraded", components },
    { status: ready ? 200 : 503, headers },
  );
}

function valid(reader: () => unknown): "ready" | "degraded" {
  try {
    reader();
    return "ready";
  } catch {
    return "degraded";
  }
}
