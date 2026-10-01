import { DashboardSection } from "../../../components/dashboard/section";

export default function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <>
      <p className="muted">
        Cost category identifies router classification cost separately from
        final-answer generation cost. Shadow decisions are observational and are
        never executed.
      </p>
      <DashboardSection
        title="Model runs"
        view="model-runs"
        pathname="/dashboard/model-runs"
        searchParams={searchParams}
      />
    </>
  );
}
