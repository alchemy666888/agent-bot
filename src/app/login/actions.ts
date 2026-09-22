"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { readDashboardConfig } from "../../server/config";
import { secureSecretEqual } from "../../server/auth/secret";
import {
  createSession,
  SESSION_COOKIE,
  sessionCookieOptions,
} from "../../server/auth/session";
export async function login(form: FormData) {
  const supplied = form.get("secret");
  const config = readDashboardConfig();
  if (
    typeof supplied !== "string" ||
    !secureSecretEqual(
      supplied,
      config.DASHBOARD_SECRET,
      config.SESSION_SIGNING_SECRET,
    )
  )
    redirect("/login");
  (await cookies()).set(
    SESSION_COOKIE,
    createSession(config.SESSION_SIGNING_SECRET),
    sessionCookieOptions,
  );
  redirect("/dashboard");
}
