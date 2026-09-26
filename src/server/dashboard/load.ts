import "server-only";

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { uuidV7 } from "../../shared/ids";
import { readSandboxConfig } from "../config";
import { ensureSandbox } from "../sandbox/controller";
import { installWorker, invokeWorker } from "../sandbox/transport";
import { dashboardQuerySchema, type DashboardQuery } from "./view-models";

const workerSourcePath = join(process.cwd(), "dist", "worker.mjs");

export async function loadDashboard(
  view: string,
  query: DashboardQuery,
  id?: string,
): Promise<Record<string, unknown>> {
  const payload = dashboardQuerySchema.parse(query);
  const sandbox = await ensureSandbox(readSandboxConfig());
  const workerPath = await installWorker(
    sandbox,
    await readFile(workerSourcePath),
  );
  const response = await invokeWorker(sandbox, workerPath, {
    contractVersion: 1,
    correlationId: uuidV7(),
    operation: "query",
    payload: { view, ...payload, ...(id ? { id } : {}) },
  });
  if (!response.ok || !response.data) throw new Error("DASHBOARD_QUERY_FAILED");
  return response.data;
}
