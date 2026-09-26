import { loadDashboard } from "../../../../server/dashboard/load";
import {
  dashboardQuerySchema,
  firstQueryValue,
} from "../../../../server/dashboard/view-models";
import { Records } from "../../../../components/dashboard/records";

type Loaded =
  | { status: "error" }
  | { status: "missing"; search: string; page: number }
  | {
      status: "ready";
      search: string;
      page: number;
      total: number;
      items: Record<string, unknown>[];
      conversation: Record<string, unknown>;
    };

export default async function ConversationDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const raw = await searchParams;
  const search = firstQueryValue(raw.search) ?? "";
  const page = firstQueryValue(raw.page) ?? "1";
  const pathname = `/dashboard/conversations/${id}`;
  let loaded: Loaded;
  try {
    const parsed = dashboardQuerySchema.parse({ search, page });
    const data = await loadDashboard("conversation", parsed, id);
    if (
      data.found !== true ||
      typeof data.conversation !== "object" ||
      !data.conversation
    )
      loaded = { status: "missing", search: parsed.search, page: parsed.page };
    else {
      const items = Array.isArray(data.items)
        ? (data.items as Record<string, unknown>[])
        : [];
      loaded = {
        status: "ready",
        search: parsed.search,
        page: typeof data.page === "number" ? data.page : parsed.page,
        total: typeof data.total === "number" ? data.total : items.length,
        items,
        conversation: data.conversation as Record<string, unknown>,
      };
    }
  } catch {
    loaded = { status: "error" };
  }
  if (loaded.status === "error")
    return <Records title="Conversation" pathname={pathname} error />;
  if (loaded.status === "missing")
    return (
      <Records
        title="Conversation"
        pathname={pathname}
        search={loaded.search}
        page={loaded.page}
      />
    );
  return (
    <main id="content">
      <h1>Conversation</h1>
      <p className="muted">
        Data updates when you open a page or use Refresh. This view is
        read-only.
      </p>
      <p>
        <a href={pathname}>Refresh</a>
        {" · "}
        <a href="/dashboard/conversations">All conversations</a>
      </p>
      <section className="card">
        <h2>Details</h2>
        <dl className="record-fields">
          {Object.entries(loaded.conversation)
            .filter(([key]) => key !== "schemaVersion")
            .map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>
                  {value === null || value === undefined
                    ? "None"
                    : String(value)}
                </dd>
              </div>
            ))}
        </dl>
      </section>
      <Records
        title="Messages"
        pathname={pathname}
        search={loaded.search}
        page={loaded.page}
        total={loaded.total}
        items={loaded.items}
        embedded
      />
    </main>
  );
}
