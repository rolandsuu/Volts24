import { NextResponse } from "next/server";

import { normalizePrompt } from "@/lib/upload-records";
import {
  queueVideoProcessing,
  VideoProcessingQueueError,
} from "@/lib/video-processing";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

type CompleteBatchUploadContext = {
  params: Promise<{
    batchId: string;
  }>;
};

type CompleteBatchUploadBody = {
  prompt?: unknown;
};

type BatchRow = {
  id: string;
};

type BatchVideoRow = {
  id: string;
  batch_position: number | null;
  original_filename: string | null;
};

type BatchVideoResult =
  | {
      videoId: string;
      batchPosition: number | null;
      filename: string | null;
      status: "queued";
      triggerRunId: string;
    }
  | {
      videoId: string;
      batchPosition: number | null;
      filename: string | null;
      status: "failed";
      error: string;
      errorStatus: number;
    };

function errorResponse(error: string, status: number) {
  return NextResponse.json({ error }, { status });
}

function getQueueError(error: unknown) {
  if (error instanceof VideoProcessingQueueError) {
    return {
      message: error.message,
      status: error.status,
    };
  }

  return {
    message: error instanceof Error ? error.message : "Failed to queue video",
    status: 500,
  };
}

async function queueBatchVideo(video: BatchVideoRow): Promise<BatchVideoResult> {
  try {
    const result = await queueVideoProcessing(video.id, {
      allowedStatuses: ["created", "uploaded"],
    });

    return {
      videoId: video.id,
      batchPosition: video.batch_position,
      filename: video.original_filename,
      status: "queued",
      triggerRunId: result.triggerRunId,
    };
  } catch (error) {
    const queueError = getQueueError(error);

    return {
      videoId: video.id,
      batchPosition: video.batch_position,
      filename: video.original_filename,
      status: "failed",
      error: queueError.message,
      errorStatus: queueError.status,
    };
  }
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

  const { data: batchData, error: batchError } = await supabaseAdmin
    .from("video_batches")
    .select("id")
    .eq("id", batchId)
    .single();

  if (batchError) {
    if (batchError.code === "PGRST116") {
      return errorResponse("Video batch not found", 404);
    }

    return errorResponse(
      `Failed to load video batch: ${batchError.message}`,
      500
    );
  }

  const batch = batchData as BatchRow;
  const { data: videosData, error: videosError } = await supabaseAdmin
    .from("videos")
    .select("id,batch_position,original_filename")
    .eq("batch_id", batch.id)
    .order("batch_position", { ascending: true })
    .order("created_at", { ascending: true });

  if (videosError) {
    return errorResponse(`Failed to load videos: ${videosError.message}`, 500);
  }

  const videos = (videosData ?? []) as BatchVideoRow[];

  if (videos.length === 0) {
    return errorResponse("Video batch has no videos", 409);
  }

  const { error: updateError } = await supabaseAdmin
    .from("videos")
    .update({
      prompt: sharedPrompt,
      updated_at: new Date().toISOString(),
    })
    .eq("batch_id", batch.id);

  if (updateError) {
    return errorResponse(
      `Failed to update video prompts: ${updateError.message}`,
      500
    );
  }

  const results = await Promise.all(
    videos.map((video) => queueBatchVideo(video))
  );
  const queuedCount = results.filter(
    (video) => video.status === "queued"
  ).length;
  const failedCount = results.length - queuedCount;

  return NextResponse.json({
    batchId: batch.id,
    totalVideos: results.length,
    queuedCount,
    failedCount,
    videos: results,
  });
}
