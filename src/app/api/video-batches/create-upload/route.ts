import { NextResponse } from "next/server";

import {
  MAX_BATCH_UPLOAD_FILES,
  UploadValidationError,
  assertValidVideoUploadInput,
  createVideoUploadRecord,
  getTrimmedString,
  normalizePrompt,
  type VideoUploadInput,
} from "@/lib/upload-records";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

type CreateBatchUploadBody = {
  title?: unknown;
  targetLanguage?: unknown;
  videos?: unknown;
};

type BatchRow = {
  id: string;
};

function errorResponse(error: string, status: number) {
  return NextResponse.json({ error }, { status });
}

function parseVideoInput(
  value: unknown,
  targetLanguage: string
): Omit<VideoUploadInput, "batchId" | "batchPosition"> {
  if (typeof value !== "object" || value === null) {
    throw new UploadValidationError("Each video must be an object");
  }

  const video = value as {
    filename?: unknown;
    contentType?: unknown;
    size?: unknown;
  };
  const filename = getTrimmedString(video.filename);
  const contentType = getTrimmedString(video.contentType);

  if (!filename || !contentType) {
    throw new UploadValidationError(
      "Each video requires filename and contentType"
    );
  }

  if (typeof video.size !== "number") {
    throw new UploadValidationError("Each video requires a numeric size");
  }

  const input = {
    filename,
    contentType,
    size: video.size,
    prompt: normalizePrompt(null),
    targetLanguage,
  };

  assertValidVideoUploadInput(input);

  return input;
}

export async function POST(request: Request) {
  let body: CreateBatchUploadBody;

  try {
    body = (await request.json()) as CreateBatchUploadBody;
  } catch {
    return errorResponse("Request body must be valid JSON", 400);
  }

  const title = getTrimmedString(body.title);
  const targetLanguage = getTrimmedString(body.targetLanguage);

  if (!title || !targetLanguage) {
    return errorResponse("title and targetLanguage are required", 400);
  }

  if (!Array.isArray(body.videos)) {
    return errorResponse("videos must be an array", 400);
  }

  if (body.videos.length === 0) {
    return errorResponse("At least one video is required", 400);
  }

  if (body.videos.length > MAX_BATCH_UPLOAD_FILES) {
    return errorResponse(
      `A batch can include at most ${MAX_BATCH_UPLOAD_FILES} videos`,
      400
    );
  }

  let videoInputs: Array<Omit<VideoUploadInput, "batchId" | "batchPosition">>;

  try {
    videoInputs = body.videos.map((video) =>
      parseVideoInput(video, targetLanguage)
    );
  } catch (error) {
    if (error instanceof UploadValidationError) {
      return errorResponse(error.message, error.status);
    }

    const message =
      error instanceof Error ? error.message : "Invalid video upload input";

    return errorResponse(message, 400);
  }

  const { data: batchData, error: batchError } = await supabaseAdmin
    .from("video_batches")
    .insert({
      title,
      target_language: targetLanguage,
      expected_video_count: body.videos.length,
    })
    .select("id")
    .single();

  if (batchError) {
    return errorResponse(
      `Failed to create video batch: ${batchError.message}`,
      500
    );
  }

  const batch = batchData as BatchRow;

  try {
    const videos = await Promise.all(
      videoInputs.map((video, index) =>
        createVideoUploadRecord({
          ...video,
          batchId: batch.id,
          batchPosition: index,
        })
      )
    );

    return NextResponse.json({
      batchId: batch.id,
      videos,
    });
  } catch (error) {
    if (error instanceof UploadValidationError) {
      return errorResponse(error.message, error.status);
    }

    const message =
      error instanceof Error ? error.message : "Failed to create upload URLs";

    return errorResponse(message, 500);
  }
}
