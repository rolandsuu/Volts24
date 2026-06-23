import { NextResponse } from "next/server";

import { AuthError } from "@/lib/auth";
import { loadAccessibleVideoBatchStatus } from "@/lib/video-batches";

export const runtime = "nodejs";

type BatchContext = {
  params: Promise<{
    batchId: string;
  }>;
};

function errorResponse(error: string, status: number) {
  return NextResponse.json({ error }, { status });
}

export async function GET(_request: Request, context: BatchContext) {
  const { batchId } = await context.params;

  if (!batchId) {
    return errorResponse("Missing batchId", 400);
  }

  try {
    return NextResponse.json(await loadAccessibleVideoBatchStatus(batchId));
  } catch (error) {
    if (error instanceof AuthError) {
      return errorResponse(error.message, error.status);
    }

    const message =
      error instanceof Error ? error.message : "Failed to load video batch";

    return errorResponse(message, 500);
  }
}
