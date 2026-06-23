import { redirect } from "next/navigation";

import { HistoryWorkspace } from "@/app/_components/history-workspace";
import { getAuthenticatedUser } from "@/lib/auth";

export default async function HistoryPage() {
  const user = await getAuthenticatedUser();

  if (!user) {
    redirect("/login?next=/history");
  }

  return <HistoryWorkspace />;
}
