import { NextResponse } from "next/server";

import { AuthError } from "@/lib/auth";
import { loadAccessibleVideo } from "@/lib/ownership";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

type UploadFailedContext = {
  params: Promise<{
    videoId: string;
  }>;
};

type UploadFailedBody = {
  error?: unknown;
};

type VideoRow = {
  status: string;
  user_id: string | null;
};

const MARK_FAILED_STATUSES = new Set(["created", "uploaded"]);

function errorResponse(error: string, status: number) {
  return NextResponse.json({ error }, { status });
}

function getErrorMessage(body: UploadFailedBody) {
  if (typeof body.error === "string" && body.error.trim()) {
    return body.error.trim().slice(0, 500);
  }

  return "Upload to R2 failed";
}

export async function POST(request: Request, context: UploadFailedContext) {
  const { videoId } = await context.params;

  if (!videoId) {
    return errorResponse("Missing videoId", 400);
  }

  let body: UploadFailedBody = {};

  try {
    body = (await request.json()) as UploadFailedBody;
  } catch {
    body = {};
  }

  let video: VideoRow;

  try {
    video = await loadAccessibleVideo<VideoRow>(videoId, "status,user_id");
  } catch (error) {
    if (error instanceof AuthError) {
      return errorResponse(error.message, error.status);
    }

    const message =
      error instanceof Error ? error.message : "Failed to load video";

    return errorResponse(message, 500);
  }

  if (!MARK_FAILED_STATUSES.has(video.status)) {
    return errorResponse(
      `Video cannot be marked upload failed from status ${video.status}`,
      409
    );
  }

  const { error: updateError } = await supabaseAdmin
    .from("videos")
    .update({
      status: "failed",
      current_stage: "upload_failed",
      error_message: getErrorMessage(body),
      error_code: "upload_failed",
      error_provider: "client_upload",
      retryable: true,
      updated_at: new Date().toISOString(),
    })
    .eq("id", videoId);

  if (updateError) {
    return errorResponse(
      `Failed to mark upload failed: ${updateError.message}`,
      500
    );
  }

  return NextResponse.json({
    videoId,
    status: "failed",
    currentStage: "upload_failed",
  });
}
