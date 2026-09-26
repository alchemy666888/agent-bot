const UNAVAILABLE = new Set([
  "inputCount",
  "outputCount",
  "estimatedCost",
  "inputPricePerMillion",
  "outputPricePerMillion",
  "providerRequestId",
  "latencyMs",
]);

const LABELS: Record<string, string> = {
  telegramUserId: "Telegram user ID",
  username: "Username",
  languageCode: "Language code",
  firstSeenAt: "First seen",
  lastSeenAt: "Last seen",
  conversationId: "Conversation",
  userId: "User",
  createdAt: "Created",
  updatedAt: "Updated",
  archivedAt: "Archived",
  inputCount: "Input tokens",
  outputCount: "Output tokens",
  estimatedCost: "Estimated cost",
  inputPricePerMillion: "Input price per million",
  outputPricePerMillion: "Output price per million",
  providerRequestId: "Provider request ID",
  latencyMs: "Latency (ms)",
  thinkingEnabled: "Thinking",
  requestMessageId: "Request message",
  responseMessageId: "Response message",
};

function label(key: string): string {
  return LABELS[key] ?? key.replaceAll("_", " ");
}

function display(key: string, value: unknown): string {
  if (value === null || value === undefined || value === "")
    return UNAVAILABLE.has(key) ? "Unavailable" : "None";
  return String(value);
}

function recordKey(item: Record<string, unknown>, index: number): string {
  const id = item.id ?? item.entityId ?? item.telegramUserId;
  return typeof id === "string" || typeof id === "number"
    ? String(id)
    : String(index);
}

export function Records({
  title,
  pathname,
  items = [],
  page = 1,
  pageSize = 50,
  total = 0,
  search = "",
  error = false,
  linkRecords = false,
  embedded = false,
}: {
  title: string;
  pathname: string;
  items?: Record<string, unknown>[];
  page?: number;
  pageSize?: number;
  total?: number;
  search?: string;
  error?: boolean;
  linkRecords?: boolean;
  embedded?: boolean;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const query = (nextPage: number) => {
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (nextPage > 1) params.set("page", String(nextPage));
    const text = params.toString();
    return text ? `${pathname}?${text}` : pathname;
  };
  const Root = embedded ? "section" : "main";
  const Heading = embedded ? "h2" : "h1";
  return (
    <Root id={embedded ? undefined : "content"}>
      <Heading>{title}</Heading>
      {embedded ? null : (
        <>
          <p className="muted">
            Data updates when you open a page or use Refresh. This view is
            read-only.
          </p>
          <p>
            <a href={query(page)}>Refresh</a>
          </p>
        </>
      )}
      <form className="search" role="search" method="get" action={pathname}>
        <label htmlFor="search">Search {title.toLowerCase()}</label>
        <input
          id="search"
          name="search"
          defaultValue={search}
          autoComplete="off"
        />
        <button type="submit">Search</button>
      </form>
      {error ? (
        <p className="error" role="alert">
          These records could not be loaded.
        </p>
      ) : (
        <section className="card">
          <h2>
            {total} {total === 1 ? "record" : "records"}
          </h2>
          {items.length ? (
            <ul className="records">
              {items.map((item, index) => {
                const id = item.id ?? item.entityId;
                return (
                  <li key={recordKey(item, index)}>
                    <dl className="record-fields">
                      {Object.entries(item)
                        .filter(([key]) => key !== "schemaVersion")
                        .map(([key, value]) => (
                          <div key={key}>
                            <dt>{label(key)}</dt>
                            <dd>{display(key, value)}</dd>
                          </div>
                        ))}
                    </dl>
                    {linkRecords && typeof id === "string" ? (
                      <a href={`/dashboard/conversations/${id}`}>
                        Open conversation
                      </a>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="muted">No records found.</p>
          )}
        </section>
      )}
      <nav aria-label="Pagination">
        {page > 1 ? <a href={query(page - 1)}>Previous page</a> : null}
        <span>
          Page {page} of {pages}
        </span>
        {page * pageSize < total ? (
          <a href={query(page + 1)}>Next page</a>
        ) : null}
      </nav>
    </Root>
  );
}
