import { redirect } from "next/navigation";

import { UploadWorkspace } from "@/app/_components/upload-workspace";
import { getAuthenticatedUser } from "@/lib/auth";
import { listUserVideoJobs } from "@/lib/video-history";

type HomeProps = {
  searchParams: Promise<{
    batch?: string | string[];
  }>;
};

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function Home({ searchParams }: HomeProps) {
  const user = await getAuthenticatedUser();

  if (!user) {
    redirect("/login?next=/");
  }

  const params = await searchParams;
  const initialSelectedBatchId = firstParam(params.batch) ?? null;
  const history = await listUserVideoJobs(user.id);

  return (
    <UploadWorkspace
      initialHistory={history}
      initialSelectedBatchId={initialSelectedBatchId}
      userEmail={user.email}
    />
  );
}
