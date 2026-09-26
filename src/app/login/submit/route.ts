import { NextResponse } from "next/server";
import {
  browserUrl,
  isSameOriginSubmission,
} from "../../../server/auth/origin";
import { secureSecretEqual } from "../../../server/auth/secret";
import {
  createSession,
  SESSION_COOKIE,
  sessionCookieOptions,
} from "../../../server/auth/session";
import { readDashboardConfig } from "../../../server/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isSameOriginSubmission(request))
    return new NextResponse(null, { status: 403 });
  const form = await request.formData();
  const supplied = form.get("secret");
  let config;
  try {
    config = readDashboardConfig();
  } catch {
    return new NextResponse(null, { status: 503 });
  }
  const accepted =
    typeof supplied === "string" &&
    secureSecretEqual(
      supplied,
      config.DASHBOARD_SECRET,
      config.SESSION_SIGNING_SECRET,
    );
  const response = NextResponse.redirect(
    browserUrl(request, accepted ? "/dashboard" : "/login"),
    303,
  );
  if (accepted)
    response.cookies.set(
      SESSION_COOKIE,
      createSession(config.SESSION_SIGNING_SECRET),
      sessionCookieOptions,
    );
  return response;
}
