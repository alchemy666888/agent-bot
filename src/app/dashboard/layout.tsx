import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { readDashboardConfig } from "../../server/config";
import { SESSION_COOKIE, validateSession } from "../../server/auth/session";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export default async function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  const config = readDashboardConfig();
  const session = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!validateSession(session, config.SESSION_SIGNING_SECRET))
    redirect("/login");
  return (
    <div className="shell">
      <header>
        <strong>Telegram Agent</strong>
        <nav className="nav" aria-label="Dashboard">
          <a href="/dashboard">Overview</a>
          <a href="/dashboard/users">Users</a>
          <a href="/dashboard/conversations">Conversations</a>
          <a href="/dashboard/messages">Messages</a>
          <a href="/dashboard/model-runs">Usage</a>
          <a href="/dashboard/errors">Errors</a>
          <a href="/api/download">Download</a>
          <form action="/logout" method="post">
            <button>Log out</button>
          </form>
        </nav>
      </header>
      {children}
    </div>
  );
}
