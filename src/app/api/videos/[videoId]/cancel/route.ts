import { runs } from "@trigger.dev/sdk/v3";
import { NextResponse } from "next/server";

import { AuthError } from "@/lib/auth";
import { loadAccessibleVideo } from "@/lib/ownership";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

type CancelContext = {
  params: Promise<{
    videoId: string;
  }>;
};

type CancelVideoRow = {
  status: string;
  current_stage: string | null;
  trigger_run_id: string | null;
  user_id: string | null;
};

const CANCELABLE_STATUSES = new Set(["queued", "processing"]);

function errorResponse(error: string, status: number) {
  return NextResponse.json({ error }, { status });
}

export async function POST(_request: Request, context: CancelContext) {
  const { videoId } = await context.params;

  if (!videoId) {
    return errorResponse("Missing videoId", 400);
  }

  let video: CancelVideoRow;

  try {
    video = await loadAccessibleVideo<CancelVideoRow>(
      videoId,
      "status,current_stage,trigger_run_id,user_id"
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return errorResponse(error.message, error.status);
    }

    const message =
      error instanceof Error ? error.message : "Failed to load video";

    return errorResponse(message, 500);
  }

  if (!CANCELABLE_STATUSES.has(video.status)) {
    return errorResponse(`Video cannot be canceled from status ${video.status}`, 409);
  }

  if (video.current_stage === "transcript_ready") {
    return errorResponse("Transcript milestone is already complete", 409);
  }

  if (!video.trigger_run_id) {
    return errorResponse("Video has no Trigger run to cancel", 400);
  }

  try {
    await runs.cancel(video.trigger_run_id);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to cancel Trigger run";

    return errorResponse(message, 500);
  }

  const { error: updateError } = await supabaseAdmin
    .from("videos")
    .update({
      status: "failed",
      current_stage: "canceled",
      error_message: "Processing canceled by user",
      error_code: "user_canceled",
      error_provider: "trigger.dev",
      retryable: false,
      updated_at: new Date().toISOString(),
    })
    .eq("id", videoId);

  if (updateError) {
    return errorResponse(`Failed to mark video canceled: ${updateError.message}`, 500);
  }

  return NextResponse.json({
    videoId,
    status: "failed",
    currentStage: "canceled",
  });
}
