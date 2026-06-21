import { NextResponse } from "next/server";

import { normalizePrompt } from "@/lib/upload-records";
import { AuthError } from "@/lib/auth";
import { loadAccessibleBatch } from "@/lib/ownership";
import {
  queueUploadSession,
  VideoProcessingQueueError,
} from "@/lib/video-processing";

export const runtime = "nodejs";

type CompleteBatchUploadContext = {
  params: Promise<{
    batchId: string;
  }>;
};

type CompleteBatchUploadBody = {
  prompt?: unknown;
};

function errorResponse(error: string, status: number) {
  return NextResponse.json({ error }, { status });
}

export async function POST(
  request: Request,
  context: CompleteBatchUploadContext
) {
  const { batchId } = await context.params;

  if (!batchId) {
    return errorResponse("Missing batchId", 400);
  }

  let body: CompleteBatchUploadBody;

  try {
    body = (await request.json()) as CompleteBatchUploadBody;
  } catch {
    return errorResponse("Request body must be valid JSON", 400);
  }

  const sharedPrompt = normalizePrompt(body.prompt);

  try {
    await loadAccessibleBatch<{ user_id: string | null }>(
      batchId,
      "id,user_id"
    );

    return NextResponse.json(
      await queueUploadSession(batchId, { prompt: sharedPrompt })
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return errorResponse(error.message, error.status);
    }

    if (error instanceof VideoProcessingQueueError) {
      return errorResponse(error.message, error.status);
    }

    const message =
      error instanceof Error ? error.message : "Failed to queue upload session";

    return errorResponse(message, 500);
  }
}
