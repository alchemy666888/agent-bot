import { DashboardSection } from "../../../components/dashboard/section";

export default function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <DashboardSection
      title="Conversations"
      view="conversations"
      pathname="/dashboard/conversations"
      searchParams={searchParams}
      linkRecords
    />
  );
}
