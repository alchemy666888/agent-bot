import { DashboardSection } from "../../../components/dashboard/section";

export default function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <DashboardSection
      title="Model runs"
      view="model-runs"
      pathname="/dashboard/model-runs"
      searchParams={searchParams}
    />
  );
}
