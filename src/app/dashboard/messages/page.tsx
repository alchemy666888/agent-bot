import { DashboardSection } from "../../../components/dashboard/section";

export default function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <DashboardSection
      title="Messages"
      view="messages"
      pathname="/dashboard/messages"
      searchParams={searchParams}
    />
  );
}
