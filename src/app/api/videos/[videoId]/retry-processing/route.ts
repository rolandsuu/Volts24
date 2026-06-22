import { NextResponse } from "next/server";

import { AuthError } from "@/lib/auth";
import { loadAccessibleVideo } from "@/lib/ownership";
import {
  retryVideoProcessing,
  VideoProcessingQueueError,
} from "@/lib/video-processing";

export const runtime = "nodejs";

type RetryProcessingContext = {
  params: Promise<{
    videoId: string;
  }>;
};

function errorResponse(error: string, status: number) {
  return NextResponse.json({ error }, { status });
}

export async function POST(_request: Request, context: RetryProcessingContext) {
  const { videoId } = await context.params;

  if (!videoId) {
    return errorResponse("Missing videoId", 400);
  }

  try {
    await loadAccessibleVideo<{ user_id: string | null }>(
      videoId,
      "id,user_id"
    );

    const result = await retryVideoProcessing(videoId);

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof AuthError) {
      return errorResponse(error.message, error.status);
    }

    if (error instanceof VideoProcessingQueueError) {
      return errorResponse(error.message, error.status);
    }

    const message =
      error instanceof Error ? error.message : "Failed to retry processing";

    return errorResponse(message, 500);
  }
}
