import { DashboardSection } from "../../../components/dashboard/section";

export default function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <DashboardSection
      title="Errors"
      view="errors"
      pathname="/dashboard/errors"
      searchParams={searchParams}
    />
  );
}
