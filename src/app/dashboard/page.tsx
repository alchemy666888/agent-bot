import { loadDashboard } from "../../server/dashboard/load";
import { dashboardQuerySchema } from "../../server/dashboard/view-models";

const LABELS: Record<string, string> = {
  users: "Users",
  conversations: "Conversations",
  messages: "Messages",
  "model-runs": "Model runs",
  errors: "Errors",
};

export default async function Overview() {
  let totals: Record<string, number> | undefined;
  let error = false;
  try {
    const data = await loadDashboard(
      "overview",
      dashboardQuerySchema.parse({}),
    );
    totals = Object.fromEntries(
      Object.keys(LABELS).map((key) => [
        key,
        typeof data[key] === "number" ? data[key] : Number.NaN,
      ]),
    );
    if (Object.values(totals).some((value) => !Number.isFinite(value)))
      error = true;
  } catch {
    error = true;
  }
  return (
    <main id="content">
      <h1>Overview</h1>
      <p className="muted">
        Data updates when you open a page or use Refresh. This view is
        read-only.
      </p>
      <p>
        <a href="/dashboard">Refresh</a>
      </p>
      {error ? (
        <p className="error" role="alert">
          These records could not be loaded.
        </p>
      ) : (
        <section className="card">
          <h2>Persisted records</h2>
          <dl className="record-fields">
            {Object.entries(LABELS).map(([key, label]) => (
              <div key={key}>
                <dt>{label}</dt>
                <dd>{totals?.[key] ?? 0}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
    </main>
  );
}
