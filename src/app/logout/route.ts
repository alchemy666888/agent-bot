import { NextResponse } from "next/server";
import { browserUrl, isSameOriginSubmission } from "../../server/auth/origin";
import { SESSION_COOKIE } from "../../server/auth/session";

export async function POST(request: Request) {
  if (!isSameOriginSubmission(request))
    return new NextResponse(null, { status: 403 });
  const response = NextResponse.redirect(browserUrl(request, "/login"), 303);
  response.cookies.set(SESSION_COOKIE, "", {
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    maxAge: 0,
  });
  return response;
}
