import { DashboardSection } from "../../../components/dashboard/section";

export default function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <DashboardSection
      title="Users"
      view="users"
      pathname="/dashboard/users"
      searchParams={searchParams}
    />
  );
}
