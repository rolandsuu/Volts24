import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { NextResponse } from "next/server";

import { r2, R2_BUCKET_NAME } from "@/lib/r2";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

type CompleteUploadContext = {
  params: Promise<{
    videoId: string;
  }>;
};

type VideoUploadRow = {
  id: string;
  original_r2_key: string | null;
};

function errorResponse(error: string, status: number) {
  return NextResponse.json({ error }, { status });
}

function getHttpStatus(error: unknown) {
  const metadata = (error as { $metadata?: { httpStatusCode?: unknown } })
    .$metadata;

  return typeof metadata?.httpStatusCode === "number"
    ? metadata.httpStatusCode
    : null;
}

export async function POST(_request: Request, context: CompleteUploadContext) {
  const { videoId } = await context.params;

  if (!videoId) {
    return errorResponse("Missing videoId", 400);
  }

  const { data, error: selectError } = await supabaseAdmin
    .from("videos")
    .select("id,original_r2_key")
    .eq("id", videoId)
    .single();

  if (selectError) {
    if (selectError.code === "PGRST116") {
      return errorResponse("Video not found", 404);
    }

    return errorResponse(
      `Failed to load video record: ${selectError.message}`,
      500
    );
  }

  const video = data as VideoUploadRow | null;

  if (!video?.original_r2_key) {
    return errorResponse("Video record is missing an R2 object key", 500);
  }

  try {
    await r2.send(
      new HeadObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: video.original_r2_key,
      })
    );
  } catch (error) {
    const status = getHttpStatus(error);

    if (status === 404) {
      return errorResponse("Uploaded object was not found in R2", 400);
    }

    const message =
      error instanceof Error ? error.message : "Failed to verify R2 upload";

    return errorResponse(message, 500);
  }

  const { error: updateError } = await supabaseAdmin
    .from("videos")
    .update({
      status: "uploaded",
      progress: 0,
      current_stage: "uploaded",
      error_message: null,
      error_code: null,
      error_provider: null,
      provider_request_id: null,
      retryable: null,
      transcript_r2_key: null,
      visual_timeline_r2_key: null,
      edit_plan_r2_key: null,
      voiceover_script_r2_key: null,
      subtitle_r2_key: null,
      final_r2_key: null,
      provider_run_ids: {},
      trigger_run_id: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", videoId);

  if (updateError) {
    return errorResponse(
      `Failed to mark video uploaded: ${updateError.message}`,
      500
    );
  }

  return NextResponse.json({
    videoId,
    status: "uploaded",
  });
}
