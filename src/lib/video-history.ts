import { supabaseAdmin } from "./supabase-admin.ts";

export type VideoJobHistoryItem = {
  id: string;
  title: string;
  targetLanguage: string;
  expectedVideoCount: number;
  videoCount: number;
  activeCount: number;
  completedCount: number;
  failedCount: number;
  status: "active" | "completed" | "failed" | "created";
  updatedAt: string;
  createdAt: string;
};

type BatchRow = {
  id: string;
  title: string;
  target_language: string;
  expected_video_count: number;
  created_at: string;
  updated_at: string;
};

type BatchVideoRow = {
  batch_id: string | null;
  status: string;
  updated_at: string;
};

function isTerminalStatus(status: string) {
  return status === "completed" || status === "failed";
}

function getLatestDate(first: string, second: string) {
  return new Date(first).getTime() >= new Date(second).getTime()
    ? first
    : second;
}

function getHistoryStatus(input: {
  videoCount: number;
  expectedVideoCount: number;
  activeCount: number;
  completedCount: number;
  failedCount: number;
}): VideoJobHistoryItem["status"] {
  if (input.activeCount > 0) {
    return "active";
  }

  if (
    input.videoCount >= input.expectedVideoCount &&
    input.completedCount === input.videoCount &&
    input.videoCount > 0
  ) {
    return "completed";
  }

  if (input.failedCount > 0) {
    return "failed";
  }

  return "created";
}

export async function listUserVideoJobs(userId: string) {
  const { data: batchData, error: batchError } = await supabaseAdmin
    .from("video_batches")
    .select("id,title,target_language,expected_video_count,created_at,updated_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(50);

  if (batchError) {
    throw new Error(`Failed to load video history: ${batchError.message}`);
  }

  const batches = (batchData ?? []) as BatchRow[];
  const batchIds = batches.map((batch) => batch.id);

  if (batchIds.length === 0) {
    return [];
  }

  const { data: videoData, error: videoError } = await supabaseAdmin
    .from("videos")
    .select("batch_id,status,updated_at")
    .in("batch_id", batchIds);

  if (videoError) {
    throw new Error(`Failed to load video history items: ${videoError.message}`);
  }

  const videosByBatch = new Map<string, BatchVideoRow[]>();

  for (const video of (videoData ?? []) as BatchVideoRow[]) {
    if (!video.batch_id) {
      continue;
    }

    const videos = videosByBatch.get(video.batch_id) ?? [];
    videos.push(video);
    videosByBatch.set(video.batch_id, videos);
  }

  return batches
    .map((batch) => {
      const videos = videosByBatch.get(batch.id) ?? [];
      const completedCount = videos.filter(
        (video) => video.status === "completed"
      ).length;
      const failedCount = videos.filter(
        (video) => video.status === "failed"
      ).length;
      const activeCount = videos.filter(
        (video) => !isTerminalStatus(video.status)
      ).length;
      const updatedAt = videos.reduce(
        (latest, video) => getLatestDate(latest, video.updated_at),
        batch.updated_at
      );

      return {
        id: batch.id,
        title: batch.title,
        targetLanguage: batch.target_language,
        expectedVideoCount: batch.expected_video_count,
        videoCount: videos.length,
        activeCount,
        completedCount,
        failedCount,
        status: getHistoryStatus({
          videoCount: videos.length,
          expectedVideoCount: batch.expected_video_count,
          activeCount,
          completedCount,
          failedCount,
        }),
        updatedAt,
        createdAt: batch.created_at,
      };
    })
    .sort(
      (left, right) =>
        new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
    );
}
