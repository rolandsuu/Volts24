import { redirect } from "next/navigation";

import { UploadWorkspace } from "@/app/_components/upload-workspace";
import { getAuthenticatedUser } from "@/lib/auth";

export default async function Home() {
  const user = await getAuthenticatedUser();

  if (!user) {
    redirect("/login?next=/");
  }

  return <UploadWorkspace />;
}
