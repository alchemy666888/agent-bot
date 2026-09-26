import { loadDashboard } from "../../server/dashboard/load";
import {
  dashboardQuerySchema,
  firstQueryValue,
} from "../../server/dashboard/view-models";
import { Records } from "./records";

export async function DashboardSection({
  title,
  view,
  pathname,
  searchParams,
  linkRecords = false,
}: {
  title: string;
  view: "users" | "conversations" | "messages" | "model-runs" | "errors";
  pathname: string;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
  linkRecords?: boolean;
}) {
  const raw = await searchParams;
  const search = firstQueryValue(raw.search) ?? "";
  const page = firstQueryValue(raw.page) ?? "1";
  let loaded:
    | {
        search: string;
        page: number;
        total: number;
        items: Record<string, unknown>[];
      }
    | undefined;
  try {
    const parsed = dashboardQuerySchema.parse({ search, page });
    const data = await loadDashboard(view, parsed);
    const items = Array.isArray(data.items) ? data.items : null;
    const total = typeof data.total === "number" ? data.total : null;
    if (
      !items ||
      total === null ||
      items.some((item) => !item || typeof item !== "object")
    )
      throw new Error("DASHBOARD_QUERY_INVALID");
    loaded = {
      search: parsed.search,
      page: parsed.page,
      total,
      items: items as Record<string, unknown>[],
    };
  } catch {
    loaded = undefined;
  }
  if (!loaded)
    return (
      <Records
        title={title}
        pathname={pathname}
        search={search}
        error
        linkRecords={linkRecords}
      />
    );
  return (
    <Records
      title={title}
      pathname={pathname}
      search={loaded.search}
      page={loaded.page}
      total={loaded.total}
      items={loaded.items}
      linkRecords={linkRecords}
    />
  );
}
