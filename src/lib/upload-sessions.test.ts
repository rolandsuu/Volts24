import assert from "node:assert/strict";
import test from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://127.0.0.1:54321";
process.env.SUPABASE_SECRET_KEY ??= "test-service-key";

const {
  UploadValidationError,
  createSingleVideoUploadSession,
  createUploadSession,
  parseCreateUploadSessionBody,
} = await import("./upload-sessions.ts");

function video(filename: string) {
  return {
    filename,
    contentType: "video/mp4",
    size: 1024,
  };
}

test("one-video upload session creates a batch-shaped response", async () => {
  const input = parseCreateUploadSessionBody({
    targetLanguage: "zh",
    prompt: "  Make a launch clip  ",
    videos: [video("launch.mp4")],
  });

  const batches: unknown[] = [];
  const result = await createUploadSession(input, {
    async createBatch(batch) {
      batches.push(batch);
      return { id: "batch-one" };
    },
    async createVideo(upload) {
      return {
        videoId: `video-${upload.batchPosition}`,
        uploadUrl: `https://upload.test/${upload.batchPosition}`,
        filename: upload.filename,
        batchPosition: upload.batchPosition ?? null,
      };
    },
  });

  assert.deepEqual(batches, [
    {
      title: "launch.mp4",
      targetLanguage: "zh",
      expectedVideoCount: 1,
    },
  ]);
  assert.deepEqual(result, {
    batchId: "batch-one",
    statusUrl: "/video-batches/batch-one",
    totalVideos: 1,
    videos: [
      {
        videoId: "video-0",
        uploadUrl: "https://upload.test/0",
        filename: "launch.mp4",
        batchPosition: 0,
      },
    ],
  });
});

test("upload sessions pass user ownership into batch and video records", async () => {
  const input = {
    ...parseCreateUploadSessionBody({
      targetLanguage: "zh",
      videos: [video("owned.mp4")],
    }),
    userId: "user-123",
  };
  const batches: unknown[] = [];
  const videos: unknown[] = [];

  await createUploadSession(input, {
    async createBatch(batch) {
      batches.push(batch);
      return { id: "owned-batch" };
    },
    async createVideo(upload) {
      videos.push(upload);

      return {
        videoId: "owned-video",
        uploadUrl: "https://upload.test/owned",
        filename: upload.filename,
        batchPosition: upload.batchPosition ?? null,
      };
    },
  });

  assert.deepEqual(batches, [
    {
      title: "owned.mp4",
      targetLanguage: "zh",
      expectedVideoCount: 1,
      userId: "user-123",
    },
  ]);
  assert.deepEqual(videos, [
    {
      filename: "owned.mp4",
      contentType: "video/mp4",
      size: 1024,
      prompt: input.prompt,
      targetLanguage: "zh",
      userId: "user-123",
      batchId: "owned-batch",
      batchPosition: 0,
    },
  ]);
});

test("ten upload videos are allowed", () => {
  const input = parseCreateUploadSessionBody({
    targetLanguage: "zh",
    videos: Array.from({ length: 10 }, (_, index) =>
      video(`clip-${index + 1}.mp4`)
    ),
  });

  assert.equal(input.videos.length, 10);
  assert.equal(input.title, "clip-1.mp4 + 9 more");
});

test("eleven upload videos are rejected", () => {
  assert.throws(
    () =>
      parseCreateUploadSessionBody({
        targetLanguage: "zh",
        videos: Array.from({ length: 11 }, (_, index) =>
          video(`clip-${index + 1}.mp4`)
        ),
      }),
    {
      name: "UploadValidationError",
      message: "A batch can include at most 10 videos",
    }
  );
});

test("empty upload sessions are rejected", () => {
  assert.throws(
    () =>
      parseCreateUploadSessionBody({
        targetLanguage: "zh",
        videos: [],
      }),
    {
      name: "UploadValidationError",
      message: "At least one video is required",
    }
  );
});

test("provided upload session titles override the filename default", () => {
  const input = parseCreateUploadSessionBody({
    title: "  Customer onboarding  ",
    targetLanguage: "en",
    videos: [video("screen-recording.mp4"), video("mobile-demo.mp4")],
  });

  assert.equal(input.title, "Customer onboarding");
});

test("old single-video upload request wraps into a one-video session", async () => {
  const result = await createSingleVideoUploadSession(
    {
      filename: "legacy.mp4",
      contentType: "video/mp4",
      size: 2048,
      prompt: "Legacy prompt",
      targetLanguage: "zh",
    },
    {
      async createBatch(batch) {
        assert.deepEqual(batch, {
          title: "legacy.mp4",
          targetLanguage: "zh",
          expectedVideoCount: 1,
        });
        return { id: "legacy-batch" };
      },
      async createVideo(upload) {
        assert.equal(upload.batchId, "legacy-batch");
        assert.equal(upload.batchPosition, 0);
        assert.equal(upload.prompt, "Legacy prompt");

        return {
          videoId: "legacy-video",
          uploadUrl: "https://upload.test/legacy",
          filename: upload.filename,
          batchPosition: upload.batchPosition ?? null,
        };
      },
    }
  );

  assert.deepEqual(result, {
    videoId: "legacy-video",
    uploadUrl: "https://upload.test/legacy",
    batchId: "legacy-batch",
    statusUrl: "/video-batches/legacy-batch",
  });
});

test("upload session validation errors keep their HTTP status", () => {
  try {
    parseCreateUploadSessionBody({
      targetLanguage: "zh",
      videos: [{ ...video("notes.txt"), contentType: "text/plain" }],
    });
  } catch (error) {
    assert.ok(error instanceof UploadValidationError);
    assert.equal(error.status, 400);
    return;
  }

  assert.fail("Expected unsupported video type to throw");
});
