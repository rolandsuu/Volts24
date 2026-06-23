import type { PreparedClientUploadFile } from "@/lib/client-upload";
import type { BatchStatus } from "@/lib/client-api";

export type RejectedUploadItem = {
  id: string;
  filename: string;
  error: string;
};

export type UploadSelection = PreparedClientUploadFile<File> & {
  id: string;
};

export type UploadPhase = "creating" | "uploading" | "uploaded" | "queueing" | "failed";

export type UploadProgressItem = {
  id: string;
  videoId: string | null;
  filename: string;
  contentType: string;
  size: number;
  phase: UploadPhase;
  progress: number;
  message: string;
};

export function getErrorMessage(
  error: unknown,
  fallback = "操作失败，请稍后重试。"
) {
  return error instanceof Error ? error.message : fallback;
}

export function isTerminalStatus(status: string) {
  return status === "completed" || status === "failed" || status === "canceled";
}

export function getBatchCounts(batch: BatchStatus | null) {
  const videos = batch?.videos ?? [];
  const completedCount = videos.filter(
    (video) => video.status === "completed"
  ).length;
  const failedCount = videos.filter((video) => video.status === "failed").length;
  const activeCount = videos.filter(
    (video) => !isTerminalStatus(video.status)
  ).length;

  return {
    totalCount: batch?.expectedVideoCount ?? videos.length,
    videoCount: videos.length,
    activeCount,
    completedCount,
    failedCount,
  };
}

export function isBatchTerminal(batch: BatchStatus | null) {
  if (!batch || batch.videos.length < batch.expectedVideoCount) {
    return false;
  }

  return batch.videos.every((video) => isTerminalStatus(video.status));
}
