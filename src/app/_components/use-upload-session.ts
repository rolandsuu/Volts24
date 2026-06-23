"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, DragEvent, FormEvent } from "react";

import { prepareClientUploadFiles } from "@/lib/client-upload";
import {
  completeBatchUpload,
  createUploadSession,
  getInstructionPdfDownloadUrl,
  getVideoDownloadUrl,
  loadBatchStatus,
  loadVideoHistory,
  markUploadFailed,
  retryVideoProcessing,
  uploadFileToR2,
  type BatchStatus,
  type UploadSessionVideo,
  type VideoJobHistoryItem,
} from "@/lib/client-api";
import { DEFAULT_TARGET_LANGUAGE } from "@/lib/languages";

import {
  getBatchCounts,
  getErrorMessage,
  isBatchTerminal,
  type RejectedUploadItem,
  type UploadProgressItem,
  type UploadSelection,
} from "./upload-workspace-model";

const BATCH_STATUS_POLL_INTERVAL_MS = 3000;

type UseUploadSessionOptions = {
  loadHistory?: boolean;
};

function getUploadItemId(file: File, index: number) {
  return `${file.name}-${file.size}-${file.lastModified}-${index}`;
}

type UploadResult = {
  ok: boolean;
  selectionId: string;
};

export function useUploadSession({
  loadHistory = true,
}: UseUploadSessionOptions = {}) {
  const [prompt, setPrompt] = useState("");
  const [targetLanguage, setTargetLanguage] = useState<string>(
    DEFAULT_TARGET_LANGUAGE
  );
  const [selectedUploads, setSelectedUploads] = useState<UploadSelection[]>([]);
  const [rejectedItems, setRejectedItems] = useState<RejectedUploadItem[]>([]);
  const [uploadItems, setUploadItems] = useState<UploadProgressItem[]>([]);
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null);
  const [batchStatus, setBatchStatus] = useState<BatchStatus | null>(null);
  const [batchStatusMessage, setBatchStatusMessage] = useState<string | null>(
    null
  );
  const [batchPollVersion, setBatchPollVersion] = useState(0);
  const [videoHistory, setVideoHistory] = useState<VideoJobHistoryItem[]>([]);
  const [historyMessage, setHistoryMessage] = useState<string | null>(null);
  const [historyRefreshCount, setHistoryRefreshCount] = useState(0);
  const [isLoadingHistory, setIsLoadingHistory] = useState(loadHistory);
  const [formError, setFormError] = useState<string | null>(null);
  const [downloadingVideoId, setDownloadingVideoId] = useState<string | null>(
    null
  );
  const [downloadingInstructionPdfId, setDownloadingInstructionPdfId] =
    useState<string | null>(null);
  const [retryingVideoId, setRetryingVideoId] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const pendingResultScrollRef = useRef(false);

  const selectedTotalSize = useMemo(
    () => selectedUploads.reduce((total, item) => total + item.size, 0),
    [selectedUploads]
  );
  const canGenerate = selectedUploads.length > 0 && !isSubmitting;

  useEffect(() => {
    if (!loadHistory) {
      return;
    }

    let active = true;

    async function refreshVideoHistory() {
      setIsLoadingHistory(true);

      try {
        const history = await loadVideoHistory();

        if (active) {
          setVideoHistory(history);
          setHistoryMessage(null);
        }
      } catch (error) {
        if (active) {
          setHistoryMessage(getErrorMessage(error, "加载历史任务失败。"));
        }
      } finally {
        if (active) {
          setIsLoadingHistory(false);
        }
      }
    }

    refreshVideoHistory();

    return () => {
      active = false;
    };
  }, [historyRefreshCount, loadHistory]);

  useEffect(() => {
    if (!activeBatchId) {
      return;
    }

    const batchId = activeBatchId;
    let active = true;
    let intervalId: number | null = null;

    async function refreshBatchStatus() {
      try {
        const nextBatchStatus = await loadBatchStatus(batchId);

        if (!active) {
          return;
        }

        setBatchStatus(nextBatchStatus);

        if (isBatchTerminal(nextBatchStatus)) {
          const counts = getBatchCounts(nextBatchStatus);

          setBatchStatusMessage(
            counts.failedCount > 0
              ? "处理结束，有视频失败。"
              : "处理完成，可以下载结果。"
          );
          setIsSubmitting(false);
          setHistoryRefreshCount((value) => value + 1);

          if (intervalId !== null) {
            window.clearInterval(intervalId);
          }

          return;
        }

        setBatchStatusMessage("AI 处理状态已更新。");
      } catch (error) {
        if (active) {
          setBatchStatusMessage(
            getErrorMessage(error, "加载 AI 处理状态失败。")
          );
        }
      }
    }

    refreshBatchStatus();
    intervalId = window.setInterval(
      refreshBatchStatus,
      BATCH_STATUS_POLL_INTERVAL_MS
    );

    return () => {
      active = false;

      if (intervalId !== null) {
        window.clearInterval(intervalId);
      }
    };
  }, [activeBatchId, batchPollVersion]);

  useEffect(() => {
    if (!batchStatus || !pendingResultScrollRef.current) {
      return;
    }

    pendingResultScrollRef.current = false;
    document.getElementById("upload-progress")?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }, [batchStatus]);

  function updateUploadItem(
    id: string,
    values: Partial<Omit<UploadProgressItem, "id">>
  ) {
    setUploadItems((currentItems) =>
      currentItems.map((item) =>
        item.id === id
          ? {
              ...item,
              ...values,
            }
          : item
      )
    );
  }

  function processFiles(files: File[]) {
    if (files.length === 0 || isSubmitting) {
      return;
    }

    const prepared = prepareClientUploadFiles(files);
    const nextSelections = prepared.accepted.map((upload, index) => ({
      ...upload,
      id: getUploadItemId(upload.file, index),
    }));
    const nextRejectedItems = prepared.rejected.map((item, index) => ({
      id: `rejected-${item.filename}-${item.file.size}-${index}`,
      filename: item.filename,
      error: item.error,
    }));

    setSelectedUploads(nextSelections);
    setRejectedItems(nextRejectedItems);
    setUploadItems([]);
    setActiveBatchId(null);
    setBatchStatus(null);
    setBatchStatusMessage(null);
    pendingResultScrollRef.current = false;
    setFormError(null);
    setDownloadingVideoId(null);
    setDownloadingInstructionPdfId(null);
  }

  function openHistoryBatch(batchId: string) {
    setSelectedUploads([]);
    setRejectedItems([]);
    setUploadItems([]);
    setActiveBatchId(batchId);
    setBatchStatus(null);
    setBatchStatusMessage("正在加载任务...");
    pendingResultScrollRef.current = true;
    setFormError(null);
    setDownloadingVideoId(null);
    setDownloadingInstructionPdfId(null);
  }

  function chooseVideos(event: ChangeEvent<HTMLInputElement>) {
    processFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  }

  function handleDragEnter(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    event.stopPropagation();

    if (!isSubmitting) {
      setIsDragging(true);
    }
  }

  function handleDragOver(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    event.stopPropagation();

    if (!isSubmitting) {
      setIsDragging(true);
    }
  }

  function handleDragLeave(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(false);
  }

  function handleDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(false);
    processFiles(Array.from(event.dataTransfer.files));
  }

  async function uploadSelection(
    selection: UploadSelection,
    upload: UploadSessionVideo
  ): Promise<UploadResult> {
    updateUploadItem(selection.id, {
      videoId: upload.videoId,
      phase: "uploading",
      progress: 0,
      message: "正在上传到存储",
    });

    try {
      await uploadFileToR2({
        uploadUrl: upload.uploadUrl,
        file: selection.file,
        contentType: selection.contentType,
        onProgress: (progress) =>
          updateUploadItem(selection.id, {
            progress,
            message: progress >= 100 ? "上传完成" : "正在上传到存储",
          }),
      });

      updateUploadItem(selection.id, {
        phase: "uploaded",
        progress: 100,
        message: "上传完成",
      });

      return {
        ok: true,
        selectionId: selection.id,
      };
    } catch (error) {
      let message = getErrorMessage(error, "上传到存储失败。");

      try {
        await markUploadFailed(upload.videoId, message);
      } catch (markError) {
        message = `${message} ${getErrorMessage(
          markError,
          "记录上传失败状态失败。"
        )}`;
      }

      updateUploadItem(selection.id, {
        videoId: upload.videoId,
        phase: "failed",
        message,
      });

      return {
        ok: false,
        selectionId: selection.id,
      };
    }
  }

  async function downloadVideo(videoId: string) {
    if (downloadingVideoId) {
      return;
    }

    setDownloadingVideoId(videoId);

    try {
      window.location.href = await getVideoDownloadUrl(videoId);
    } catch (error) {
      setBatchStatusMessage(getErrorMessage(error, "下载失败，请稍后重试。"));
    } finally {
      setDownloadingVideoId(null);
    }
  }

  async function downloadInstructionPdf(videoId: string) {
    if (downloadingInstructionPdfId) {
      return;
    }

    setDownloadingInstructionPdfId(videoId);

    try {
      window.location.href = await getInstructionPdfDownloadUrl(videoId);
    } catch (error) {
      setBatchStatusMessage(
        getErrorMessage(error, "操作 PDF 下载失败，请稍后重试。")
      );
    } finally {
      setDownloadingInstructionPdfId(null);
    }
  }

  async function retryProcessing(videoId: string) {
    if (retryingVideoId) {
      return;
    }

    setRetryingVideoId(videoId);
    setBatchStatusMessage("正在重新启动 AI 处理...");

    try {
      await retryVideoProcessing(videoId);
      setBatchStatusMessage("AI 处理已重新启动。");
      setIsSubmitting(true);
      setBatchPollVersion((value) => value + 1);
      setHistoryRefreshCount((value) => value + 1);
    } catch (error) {
      setBatchStatusMessage(getErrorMessage(error, "重试处理失败，请稍后再试。"));
    } finally {
      setRetryingVideoId(null);
    }
  }

  async function submitUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!canGenerate) {
      return;
    }

    const trimmedPrompt = prompt.trim() || null;
    const uploads = selectedUploads;

    setIsSubmitting(true);
    setFormError(null);
    setActiveBatchId(null);
    setBatchStatus(null);
    setBatchStatusMessage(null);
    setRejectedItems([]);
    setUploadItems(
      uploads.map((selection) => ({
        id: selection.id,
        videoId: null,
        filename: selection.filename,
        contentType: selection.contentType,
        size: selection.size,
        phase: "creating",
        progress: 0,
        message: "正在准备上传链接",
      }))
    );

    try {
      const session = await createUploadSession(
        uploads,
        trimmedPrompt,
        targetLanguage
      );
      const uploadResults = await Promise.all(
        session.videos.map((upload, index) => {
          const selection = uploads[index];

          if (!selection) {
            return Promise.resolve({
              ok: false,
              selectionId: upload.videoId,
            });
          }

          return uploadSelection(selection, upload);
        })
      );
      const uploadedIds = new Set(
        uploadResults
          .filter((result) => result.ok)
          .map((result) => result.selectionId)
      );

      setUploadItems((currentItems) =>
        currentItems.map((item) =>
          uploadedIds.has(item.id)
            ? {
                ...item,
                phase: "queueing",
                progress: 100,
                message: "正在启动 AI 处理",
              }
            : item
        )
      );

      await completeBatchUpload(session.batchId, trimmedPrompt);
      setActiveBatchId(session.batchId);
      setBatchStatusMessage("AI 处理已启动。");
      setSelectedUploads([]);
      pendingResultScrollRef.current = true;
      setHistoryRefreshCount((value) => value + 1);
    } catch (error) {
      setFormError(getErrorMessage(error));
      setIsSubmitting(false);
    }
  }

  return {
    prompt,
    setPrompt,
    targetLanguage,
    setTargetLanguage,
    selectedUploads,
    rejectedItems,
    uploadItems,
    activeBatchId,
    batchStatus,
    batchStatusMessage,
    videoHistory: loadHistory ? videoHistory : [],
    historyMessage: loadHistory ? historyMessage : null,
    isLoadingHistory: loadHistory ? isLoadingHistory : false,
    formError,
    downloadingVideoId,
    downloadingInstructionPdfId,
    retryingVideoId,
    isDragging,
    isSubmitting,
    selectedTotalSize,
    canGenerate,
    chooseVideos,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    openHistoryBatch,
    downloadVideo,
    downloadInstructionPdf,
    retryProcessing,
    submitUpload,
  };
}
