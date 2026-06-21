import { NextResponse } from "next/server";

import {
  AuthError,
  isDevBypassUser,
  requireAuthenticatedUser,
} from "@/lib/auth";
import { listRecentVideoJobs, listUserVideoJobs } from "@/lib/video-history";

export const runtime = "nodejs";

function errorResponse(error: string, status: number) {
  return NextResponse.json({ error }, { status });
}

export async function GET() {
  try {
    const user = await requireAuthenticatedUser();
    const history = isDevBypassUser(user)
      ? await listRecentVideoJobs()
      : await listUserVideoJobs(user.id);

    return NextResponse.json({ history });
  } catch (error) {
    if (error instanceof AuthError) {
      return errorResponse(error.message, error.status);
    }

    const message =
      error instanceof Error ? error.message : "Failed to load video history";

    return errorResponse(message, 500);
  }
}
