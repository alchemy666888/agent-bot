import { cookies } from "next/headers";
import { readDashboardConfig } from "../../../server/config";
import {
  isDownloadAuthorized,
  SESSION_COOKIE,
} from "../../../server/auth/guards";
import { prepareExport } from "../../../server/export/service";
import { uuidV7 } from "../../../shared/ids";
import { logStructured, safeError } from "../../../shared/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const privateHeaders = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};

export async function GET(request: Request): Promise<Response> {
  const correlationId = uuidV7();
  const started = Date.now();
  let config;
  try {
    config = readDashboardConfig();
  } catch {
    return Response.json(
      { error: "Service unavailable" },
      { status: 503, headers: privateHeaders },
    );
  }
  const cookie = (await cookies()).get(SESSION_COOKIE)?.value;
  if (
    !isDownloadAuthorized({
      authorization: request.headers.get("authorization"),
      cookie,
      adminSecret: config.DASHBOARD_SECRET,
      signingSecret: config.SESSION_SIGNING_SECRET,
    })
  )
    return Response.json(
      { error: "Unauthorized" },
      { status: 401, headers: privateHeaders },
    );

  try {
    const exported = await prepareExport(correlationId);
    logStructured({
      correlationId,
      component: "controller",
      operation: "download",
      stage: "archive-ready",
      result: "success",
      durationMs: Date.now() - started,
      metadata: { size: exported.size },
    });
    return new Response(exported.stream, {
      headers: {
        ...privateHeaders,
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${exported.filename}"`,
        "Content-Length": String(exported.size),
      },
    });
  } catch (error) {
    logStructured({
      correlationId,
      component: "controller",
      operation: "download",
      stage: "archive",
      result: "failure",
      durationMs: Date.now() - started,
      code: safeError(error).code,
    });
    return Response.json(
      { error: "Archive unavailable" },
      { status: 503, headers: privateHeaders },
    );
  }
}
