import { NextResponse } from "next/server";

import {
  queueVideoProcessing,
  VideoProcessingQueueError,
} from "@/lib/video-processing";
import { AuthError } from "@/lib/auth";
import { loadAccessibleVideo } from "@/lib/ownership";

export const runtime = "nodejs";

type CompleteUploadContext = {
  params: Promise<{
    videoId: string;
  }>;
};

function errorResponse(error: string, status: number) {
  return NextResponse.json({ error }, { status });
}

export async function POST(_request: Request, context: CompleteUploadContext) {
  const { videoId } = await context.params;

  if (!videoId) {
    return errorResponse("Missing videoId", 400);
  }

  try {
    await loadAccessibleVideo<{ user_id: string | null }>(
      videoId,
      "id,user_id"
    );

    const result = await queueVideoProcessing(videoId, {
      allowedStatuses: ["created", "uploaded"],
    });

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof AuthError) {
      return errorResponse(error.message, error.status);
    }

    if (error instanceof VideoProcessingQueueError) {
      return errorResponse(error.message, error.status);
    }

    const message =
      error instanceof Error ? error.message : "Failed to queue processing";

    return errorResponse(message, 500);
  }
}
