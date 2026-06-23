export type BatchVideoStatus = {
  id: string;
  batchPosition: number | null;
  filename: string | null;
  contentType: string | null;
  size: number | null;
  prompt: string | null;
  status: string;
  progress: number;
  currentStage: string | null;
  errorMessage: string | null;
  retryable: boolean;
  downloadReady: boolean;
  instructionPdfReady: boolean;
  createdAt: string;
  updatedAt: string;
};

export type BatchStatus = {
  id: string;
  title: string;
  targetLanguage: string;
  expectedVideoCount: number;
  createdAt: string;
  updatedAt: string;
  videos: BatchVideoStatus[];
};

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

export type ClientUploadRequestFile = {
  filename: string;
  contentType: string;
  size: number;
};

export type UploadSessionVideo = {
  videoId: string;
  uploadUrl: string;
  filename: string;
  batchPosition: number | null;
};

export type UploadSessionResponse = {
  batchId: string;
  statusUrl: string;
  totalVideos: number;
  videos: UploadSessionVideo[];
};

const R2_UPLOAD_TIMEOUT_MS = 30 * 60 * 1000;

function buildPromptRequestBody(prompt: string | null | undefined) {
  const trimmedPrompt = typeof prompt === "string" ? prompt.trim() : "";

  return trimmedPrompt ? { prompt: trimmedPrompt } : {};
}

export async function readErrorMessage(response: Response, fallback: string) {
  await response.text().catch(() => "");
  return fallback;
}

function parseUploadSessionResponse(value: unknown): UploadSessionResponse {
  if (typeof value !== "object" || value === null) {
    throw new Error("创建上传响应无效。");
  }

  const data = value as {
    batchId?: unknown;
    statusUrl?: unknown;
    totalVideos?: unknown;
    videos?: unknown;
  };

  if (
    typeof data.batchId !== "string" ||
    typeof data.statusUrl !== "string" ||
    typeof data.totalVideos !== "number" ||
    !Array.isArray(data.videos)
  ) {
    throw new Error("创建上传响应无效。");
  }

  const videos = data.videos.map((video) => {
    if (typeof video !== "object" || video === null) {
      throw new Error("创建上传响应包含无效视频。");
    }

    const upload = video as {
      videoId?: unknown;
      uploadUrl?: unknown;
      filename?: unknown;
      batchPosition?: unknown;
    };

    if (
      typeof upload.videoId !== "string" ||
      typeof upload.uploadUrl !== "string" ||
      typeof upload.filename !== "string" ||
      !(
        typeof upload.batchPosition === "number" ||
        upload.batchPosition === null
      )
    ) {
      throw new Error("创建上传响应包含无效视频。");
    }

    return {
      videoId: upload.videoId,
      uploadUrl: upload.uploadUrl,
      filename: upload.filename,
      batchPosition: upload.batchPosition,
    };
  });

  return {
    batchId: data.batchId,
    statusUrl: data.statusUrl,
    totalVideos: data.totalVideos,
    videos,
  };
}

export async function createUploadSession(
  selectedUploads: ClientUploadRequestFile[],
  prompt: string | null | undefined,
  targetLanguage: string
) {
  const response = await fetch("/api/video-batches/create-upload", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      targetLanguage,
      ...buildPromptRequestBody(prompt),
      videos: selectedUploads.map((selection) => ({
        filename: selection.filename,
        contentType: selection.contentType,
        size: selection.size,
      })),
    }),
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, "创建上传任务失败。"));
  }

  const session = parseUploadSessionResponse(await response.json());

  if (session.videos.length !== selectedUploads.length) {
    throw new Error("创建上传响应和已选择视频不匹配。");
  }

  return session;
}

export function uploadFileToR2({
  uploadUrl,
  file,
  contentType,
  onProgress,
}: {
  uploadUrl: string;
  file: File;
  contentType: string;
  onProgress(progress: number): void;
}) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.open("PUT", uploadUrl);
    xhr.timeout = R2_UPLOAD_TIMEOUT_MS;
    xhr.setRequestHeader("Content-Type", contentType);

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || event.total <= 0) {
        onProgress(1);
        return;
      }

      onProgress(
        Math.max(1, Math.min(99, Math.round((event.loaded / event.total) * 100)))
      );
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(100);
        resolve();
        return;
      }

      reject(new Error(`存储上传失败，状态码 ${xhr.status}。`));
    };

    xhr.onerror = () => {
      reject(new Error("上传到存储时网络错误。"));
    };

    xhr.ontimeout = () => {
      reject(
        new Error(
          "上传到存储超时。请换小一点的视频，或使用更快的网络后重试。"
        )
      );
    };

    xhr.onabort = () => {
      reject(new Error("上传已取消。"));
    };

    xhr.send(file);
  });
}

export async function markUploadFailed(videoId: string, error: string) {
  const response = await fetch(
    `/api/videos/${encodeURIComponent(videoId)}/upload-failed`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ error }),
    }
  );

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, "记录上传失败状态失败。"));
  }
}

export async function completeBatchUpload(
  batchId: string,
  prompt: string | null | undefined
) {
  const response = await fetch(
    `/api/video-batches/${encodeURIComponent(batchId)}/complete-upload`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildPromptRequestBody(prompt)),
    }
  );

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, "启动 AI 处理失败。"));
  }
}

export async function retryVideoProcessing(videoId: string) {
  const response = await fetch(
    `/api/videos/${encodeURIComponent(videoId)}/retry-processing`,
    {
      method: "POST",
    }
  );

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, "重试处理失败。"));
  }
}

export async function loadBatchStatus(batchId: string) {
  const response = await fetch(
    `/api/video-batches/${encodeURIComponent(batchId)}`
  );

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, "加载 AI 处理状态失败。"));
  }

  return (await response.json()) as BatchStatus;
}

export async function loadVideoHistory() {
  const response = await fetch("/api/video-history");

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, "加载历史任务失败。"));
  }

  const data = (await response.json()) as { history?: unknown };

  if (!Array.isArray(data.history)) {
    throw new Error("历史任务响应无效。");
  }

  return data.history as VideoJobHistoryItem[];
}

export async function getVideoDownloadUrl(videoId: string) {
  const response = await fetch(
    `/api/videos/${encodeURIComponent(videoId)}/download-url`
  );

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, "下载视频失败。"));
  }

  const data = (await response.json()) as { downloadUrl?: unknown };

  if (typeof data.downloadUrl !== "string") {
    throw new Error("下载链接响应无效。");
  }

  return data.downloadUrl;
}

export async function getInstructionPdfDownloadUrl(videoId: string) {
  const response = await fetch(
    `/api/videos/${encodeURIComponent(videoId)}/instruction-pdf-url`
  );

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, "下载操作 PDF 失败。"));
  }

  const data = (await response.json()) as { pdfDownloadUrl?: unknown };

  if (typeof data.pdfDownloadUrl !== "string") {
    throw new Error("操作 PDF 响应无效。");
  }

  return data.pdfDownloadUrl;
}
