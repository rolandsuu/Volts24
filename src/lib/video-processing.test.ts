import assert from "node:assert/strict";
import test from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://127.0.0.1:54321";
process.env.SUPABASE_SECRET_KEY ??= "test-service-key";

const {
  VideoProcessingQueueError,
  queueUploadSession,
  queueVideoProcessing,
} = await import("./video-processing.ts");

function batchVideo(id: string, batchPosition: number) {
  return {
    id,
    batch_position: batchPosition,
    original_filename: `${id}.mp4`,
  };
}

test("queueUploadSession queues every video in a batch", async () => {
  const promptUpdates: unknown[] = [];
  const queuedVideoIds: string[] = [];

  const result = await queueUploadSession(
    "batch-1",
    { prompt: "Shared prompt" },
    {
      async loadVideos(batchId) {
        assert.equal(batchId, "batch-1");
        return [batchVideo("video-a", 0), batchVideo("video-b", 1)];
      },
      async updateVideoPrompts(batchId, prompt) {
        promptUpdates.push({ batchId, prompt });
      },
      async queueVideo(video) {
        queuedVideoIds.push(video.id);

        return {
          videoId: video.id,
          status: "queued",
          triggerRunId: `run-${video.id}`,
        };
      },
    }
  );

  assert.deepEqual(promptUpdates, [
    { batchId: "batch-1", prompt: "Shared prompt" },
  ]);
  assert.deepEqual(queuedVideoIds, ["video-a", "video-b"]);
  assert.equal(result.queuedCount, 2);
  assert.equal(result.failedCount, 0);
  assert.deepEqual(result.videos, [
    {
      videoId: "video-a",
      batchPosition: 0,
      filename: "video-a.mp4",
      status: "queued",
      triggerRunId: "run-video-a",
    },
    {
      videoId: "video-b",
      batchPosition: 1,
      filename: "video-b.mp4",
      status: "queued",
      triggerRunId: "run-video-b",
    },
  ]);
});

test("queueUploadSession returns mixed queue results", async () => {
  const result = await queueUploadSession(
    "batch-2",
    {},
    {
      async loadVideos() {
        return [batchVideo("video-a", 0), batchVideo("video-b", 1)];
      },
      async updateVideoPrompts() {
        assert.fail("prompt updates should not run without a prompt");
      },
      async queueVideo(video) {
        if (video.id === "video-b") {
          throw new VideoProcessingQueueError("Uploaded object was not found in R2", 400);
        }

        return {
          videoId: video.id,
          status: "queued",
          triggerRunId: "run-video-a",
        };
      },
    }
  );

  assert.equal(result.totalVideos, 2);
  assert.equal(result.queuedCount, 1);
  assert.equal(result.failedCount, 1);
  assert.deepEqual(result.videos, [
    {
      videoId: "video-a",
      batchPosition: 0,
      filename: "video-a.mp4",
      status: "queued",
      triggerRunId: "run-video-a",
    },
    {
      videoId: "video-b",
      batchPosition: 1,
      filename: "video-b.mp4",
      status: "failed",
      error: "Uploaded object was not found in R2",
      errorStatus: 400,
    },
  ]);
});

test("queueUploadSession rejects empty batches", async () => {
  await assert.rejects(
    () =>
      queueUploadSession(
        "empty-batch",
        {},
        {
          async loadVideos() {
            return [];
          },
          async updateVideoPrompts() {
            assert.fail("prompt updates should not run for empty batches");
          },
          async queueVideo() {
            assert.fail("empty batches should not queue videos");
          },
        }
      ),
    {
      name: "VideoProcessingQueueError",
      message: "Video batch has no videos",
    }
  );
});

test("missing R2 object marks the video upload_failed before returning 400", async () => {
  const updates: Array<{ videoId: string; values: Record<string, unknown> }> = [];

  await assert.rejects(
    () =>
      queueVideoProcessing(
        "video-missing",
        { allowedStatuses: ["created"] },
        {
          async loadVideo(videoId) {
            assert.equal(videoId, "video-missing");

            return {
              id: videoId,
              status: "created",
              original_r2_key: "videos/video-missing/source.mp4",
            };
          },
          async verifyUploadExists() {
            throw new VideoProcessingQueueError(
              "Uploaded object was not found in R2",
              400
            );
          },
          async triggerProcessing() {
            assert.fail("missing uploads should not trigger processing");
          },
          async updateVideo(videoId, values) {
            updates.push({ videoId, values });
          },
        }
      ),
    {
      name: "VideoProcessingQueueError",
      message: "Uploaded object was not found in R2",
    }
  );

  assert.equal(updates.length, 1);
  assert.equal(updates[0].videoId, "video-missing");
  assert.equal(updates[0].values.status, "failed");
  assert.equal(updates[0].values.current_stage, "upload_failed");
  assert.equal(updates[0].values.error_code, "upload_failed");
  assert.equal(updates[0].values.error_provider, "client_upload");
  assert.equal(updates[0].values.retryable, true);
  assert.equal(
    updates[0].values.error_message,
    "Uploaded object was not found in R2"
  );
  assert.equal(typeof updates[0].values.updated_at, "string");
});
