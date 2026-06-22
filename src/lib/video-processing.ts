import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { tasks } from "@trigger.dev/sdk/v3";

import { r2, R2_BUCKET_NAME } from "./r2.ts";
import { supabaseAdmin } from "./supabase-admin.ts";

type VideoProcessingRow = {
  id: string;
  status: string;
  original_r2_key: string | null;
};

type RetryVideoProcessingRow = VideoProcessingRow & {
  retryable: boolean | null;
};

type BatchVideoRow = {
  id: string;
  batch_position: number | null;
  original_filename: string | null;
};

export type QueueVideoProcessingOptions = {
  allowedStatuses?: readonly string[];
};

export type QueueVideoProcessingResult = {
  videoId: string;
  status: "queued";
  triggerRunId: string;
};

type TriggerRun = {
  id: string;
};

export type QueueVideoProcessingDependencies = {
  loadVideo(videoId: string): Promise<VideoProcessingRow>;
  verifyUploadExists(r2Key: string): Promise<void>;
  triggerProcessing(input: {
    videoId: string;
    originalR2Key: string;
  }): Promise<TriggerRun>;
  updateVideo(videoId: string, values: Record<string, unknown>): Promise<void>;
};

export type QueueUploadSessionOptions = {
  prompt?: string;
};

export type RetryVideoProcessingDependencies = {
  loadVideo(videoId: string): Promise<RetryVideoProcessingRow>;
  queueVideo(videoId: string): Promise<QueueVideoProcessingResult>;
};

export type QueueUploadSessionVideoResult =
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

export type QueueUploadSessionResult = {
  batchId: string;
  totalVideos: number;
  queuedCount: number;
  failedCount: number;
  videos: QueueUploadSessionVideoResult[];
};

export type QueueUploadSessionDependencies = {
  loadVideos(batchId: string): Promise<BatchVideoRow[]>;
  updateVideoPrompts(batchId: string, prompt: string): Promise<void>;
  queueVideo(video: BatchVideoRow): Promise<QueueVideoProcessingResult>;
};

export class VideoProcessingQueueError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "VideoProcessingQueueError";
    this.status = status;
  }
}

const DEFAULT_ALLOWED_STATUSES = ["uploaded"] as const;

function getHttpStatus(error: unknown) {
  const metadata = (error as { $metadata?: { httpStatusCode?: unknown } })
    .$metadata;

  return typeof metadata?.httpStatusCode === "number"
    ? metadata.httpStatusCode
    : null;
}

function queueError(message: string, status: number) {
  return new VideoProcessingQueueError(message, status);
}

function getQueueError(error: unknown, fallback: string) {
  if (error instanceof VideoProcessingQueueError) {
    return error;
  }

  return queueError(error instanceof Error ? error.message : fallback, 500);
}

function timestamped(values: Record<string, unknown>) {
  return {
    ...values,
    updated_at: new Date().toISOString(),
  };
}

async function updateVideoRecord(
  videoId: string,
  values: Record<string, unknown>
) {
  const { error } = await supabaseAdmin
    .from("videos")
    .update(values)
    .eq("id", videoId);

  if (error) {
    throw new Error(`Failed to update video record: ${error.message}`);
  }
}

async function loadVideoForProcessing(videoId: string) {
  const { data, error } = await supabaseAdmin
    .from("videos")
    .select("id,status,original_r2_key")
    .eq("id", videoId)
    .single();

  if (error) {
    if (error.code === "PGRST116") {
      throw queueError("Video not found", 404);
    }

    throw queueError(`Failed to load video record: ${error.message}`, 500);
  }

  return data as VideoProcessingRow;
}

async function loadVideoForRetry(videoId: string) {
  const { data, error } = await supabaseAdmin
    .from("videos")
    .select("id,status,original_r2_key,retryable")
    .eq("id", videoId)
    .single();

  if (error) {
    if (error.code === "PGRST116") {
      throw queueError("Video not found", 404);
    }

    throw queueError(`Failed to load video record: ${error.message}`, 500);
  }

  return data as RetryVideoProcessingRow;
}

async function verifyUploadExists(r2Key: string) {
  try {
    await r2.send(
      new HeadObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: r2Key,
      })
    );
  } catch (error) {
    const status = getHttpStatus(error);

    if (status === 404) {
      throw queueError("Uploaded object was not found in R2", 400);
    }

    const message =
      error instanceof Error ? error.message : "Failed to verify R2 upload";

    throw queueError(message, 500);
  }
}

function defaultQueueVideoProcessingDependencies(): QueueVideoProcessingDependencies {
  return {
    loadVideo: loadVideoForProcessing,
    verifyUploadExists,
    triggerProcessing(input) {
      return tasks.trigger("process-video", input);
    },
    updateVideo: updateVideoRecord,
  };
}

async function loadUploadSessionVideos(batchId: string) {
  const { data: batchData, error: batchError } = await supabaseAdmin
    .from("video_batches")
    .select("id")
    .eq("id", batchId)
    .single();

  if (batchError) {
    if (batchError.code === "PGRST116") {
      throw queueError("Video batch not found", 404);
    }

    throw queueError(`Failed to load video batch: ${batchError.message}`, 500);
  }

  const batch = batchData as { id: string };
  const { data, error } = await supabaseAdmin
    .from("videos")
    .select("id,batch_position,original_filename")
    .eq("batch_id", batch.id)
    .order("batch_position", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) {
    throw queueError(`Failed to load videos: ${error.message}`, 500);
  }

  return (data ?? []) as BatchVideoRow[];
}

async function updateUploadSessionPrompts(batchId: string, prompt: string) {
  const { error } = await supabaseAdmin
    .from("videos")
    .update(timestamped({ prompt }))
    .eq("batch_id", batchId);

  if (error) {
    throw queueError(`Failed to update video prompts: ${error.message}`, 500);
  }
}

function defaultQueueUploadSessionDependencies(): QueueUploadSessionDependencies {
  return {
    loadVideos: loadUploadSessionVideos,
    updateVideoPrompts: updateUploadSessionPrompts,
    queueVideo(video) {
      return queueVideoProcessing(video.id, {
        allowedStatuses: ["created", "uploaded"],
      });
    },
  };
}

function defaultRetryVideoProcessingDependencies(): RetryVideoProcessingDependencies {
  return {
    loadVideo: loadVideoForRetry,
    queueVideo(videoId) {
      return queueVideoProcessing(videoId, {
        allowedStatuses: ["failed"],
      });
    },
  };
}

async function markMissingUploadFailed(
  videoId: string,
  message: string,
  dependencies: QueueVideoProcessingDependencies
) {
  await dependencies.updateVideo(
    videoId,
    timestamped({
      status: "failed",
      current_stage: "upload_failed",
      error_message: message,
      error_code: "upload_failed",
      error_provider: "client_upload",
      retryable: true,
    })
  );
}

export async function queueVideoProcessing(
  videoId: string,
  options: QueueVideoProcessingOptions = {},
  dependencies: QueueVideoProcessingDependencies =
    defaultQueueVideoProcessingDependencies()
): Promise<QueueVideoProcessingResult> {
  const allowedStatuses = options.allowedStatuses ?? DEFAULT_ALLOWED_STATUSES;
  const video = await dependencies.loadVideo(videoId);

  if (!video?.original_r2_key) {
    throw queueError("Video record is missing an R2 object key", 500);
  }

  if (!allowedStatuses.includes(video.status)) {
    throw queueError(
      `Video cannot start processing from status ${video.status}`,
      409
    );
  }

  try {
    await dependencies.verifyUploadExists(video.original_r2_key);
  } catch (error) {
    const uploadError = getQueueError(error, "Failed to verify R2 upload");

    if (
      uploadError.status === 400 &&
      uploadError.message === "Uploaded object was not found in R2"
    ) {
      await markMissingUploadFailed(videoId, uploadError.message, dependencies);
    }

    throw uploadError;
  }

  let triggerRun: TriggerRun;

  try {
    triggerRun = await dependencies.triggerProcessing({
      videoId,
      originalR2Key: video.original_r2_key,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to trigger processing task";

    try {
      await dependencies.updateVideo(
        videoId,
        timestamped({
          status: "failed",
          current_stage: "queued",
          error_message: message,
          error_code: "trigger_failed",
          error_provider: "trigger.dev",
          retryable: true,
        })
      );
    } catch {
      // Keep the original Trigger error visible to the caller.
    }

    throw queueError(message, 500);
  }

  try {
    await dependencies.updateVideo(
      videoId,
      timestamped({
        status: "queued",
        progress: 5,
        current_stage: "queued",
        trigger_run_id: triggerRun.id,
        error_message: null,
        error_code: null,
        error_provider: null,
        provider_request_id: null,
        retryable: null,
        transcript_r2_key: null,
        video_event_analysis_r2_key: null,
        visual_timeline_r2_key: null,
        edit_plan_r2_key: null,
        instruction_doc_r2_key: null,
        instruction_pdf_r2_key: null,
        voiceover_script_r2_key: null,
        subtitle_r2_key: null,
        final_r2_key: null,
        provider_run_ids: {},
      })
    );
  } catch (error) {
    throw queueError(
      error instanceof Error ? error.message : "Failed to mark video queued",
      500
    );
  }

  return {
    videoId,
    status: "queued",
    triggerRunId: triggerRun.id,
  };
}

export async function retryVideoProcessing(
  videoId: string,
  dependencies: RetryVideoProcessingDependencies =
    defaultRetryVideoProcessingDependencies()
) {
  const video = await dependencies.loadVideo(videoId);

  if (video.status !== "failed") {
    throw queueError(
      `Video cannot retry processing from status ${video.status}`,
      409
    );
  }

  if (video.retryable !== true) {
    throw queueError("Video failure is not retryable", 409);
  }

  if (!video.original_r2_key) {
    throw queueError("Video cannot retry without an original R2 object", 409);
  }

  return dependencies.queueVideo(videoId);
}

async function queueUploadSessionVideo(
  video: BatchVideoRow,
  dependencies: QueueUploadSessionDependencies
): Promise<QueueUploadSessionVideoResult> {
  try {
    const result = await dependencies.queueVideo(video);

    return {
      videoId: video.id,
      batchPosition: video.batch_position,
      filename: video.original_filename,
      status: "queued",
      triggerRunId: result.triggerRunId,
    };
  } catch (error) {
    const queueVideoError = getQueueError(error, "Failed to queue video");

    return {
      videoId: video.id,
      batchPosition: video.batch_position,
      filename: video.original_filename,
      status: "failed",
      error: queueVideoError.message,
      errorStatus: queueVideoError.status,
    };
  }
}

export async function queueUploadSession(
  batchId: string,
  options: QueueUploadSessionOptions = {},
  dependencies: QueueUploadSessionDependencies =
    defaultQueueUploadSessionDependencies()
): Promise<QueueUploadSessionResult> {
  const videos = await dependencies.loadVideos(batchId);

  if (videos.length === 0) {
    throw queueError("Video batch has no videos", 409);
  }

  if (options.prompt !== undefined) {
    await dependencies.updateVideoPrompts(batchId, options.prompt);
  }

  const results = await Promise.all(
    videos.map((video) => queueUploadSessionVideo(video, dependencies))
  );
  const queuedCount = results.filter(
    (video) => video.status === "queued"
  ).length;
  const failedCount = results.length - queuedCount;

  return {
    batchId,
    totalVideos: results.length,
    queuedCount,
    failedCount,
    videos: results,
  };
}
