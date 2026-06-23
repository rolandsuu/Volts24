import type { ChangeEvent, DragEvent, FormEvent } from "react";

import {
  TARGET_LANGUAGE_OPTIONS,
} from "@/lib/languages";
import {
  getProcessingDisplay,
  type ProcessingDisplayTone,
} from "@/lib/processing-stage-copy";
import type {
  BatchStatus,
  VideoJobHistoryItem,
} from "@/lib/client-api";

import {
  getBatchCounts,
  type RejectedUploadItem,
  type UploadPhase,
  type UploadProgressItem,
  type UploadSelection,
} from "./upload-workspace-model";

const UPLOAD_ACCEPT_ATTRIBUTE =
  "video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov";

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

function formatFileSize(bytes: number) {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatVideoMeta(
  size: number | null | undefined,
  contentType: string | null | undefined
) {
  const parts: string[] = [];

  if (typeof size === "number" && size > 0) {
    parts.push(formatFileSize(size));
  }

  if (contentType) {
    parts.push(contentType);
  }

  return parts.join(" · ") || "视频文件";
}

function getPhaseLabel(phase: UploadPhase) {
  switch (phase) {
    case "creating":
      return "创建中";
    case "uploading":
      return "上传中";
    case "uploaded":
      return "已上传";
    case "queueing":
      return "排队中";
    case "failed":
      return "失败";
  }
}

function getPhaseClasses(phase: UploadPhase) {
  switch (phase) {
    case "creating":
      return {
        dot: "bg-[#ff9f0a]",
        text: "text-[#b76a00]",
        bar: "bg-[#ff9f0a]",
      };
    case "uploading":
      return {
        dot: "processing-dot-pulse bg-[#155dfc]",
        text: "text-[#155dfc]",
        bar: "bg-[#155dfc]",
      };
    case "uploaded":
    case "queueing":
      return {
        dot: "bg-[#20a03f]",
        text: "text-[#198a35]",
        bar: "bg-[#20a03f]",
      };
    case "failed":
      return {
        dot: "bg-[#e92b2b]",
        text: "text-[#c81818]",
        bar: "bg-[#e92b2b]",
      };
  }
}

function getProcessingListClasses(tone: ProcessingDisplayTone) {
  switch (tone) {
    case "success":
      return {
        dot: "bg-[#20a03f]",
        text: "text-[#198a35]",
        bar: "bg-[#20a03f]",
      };
    case "error":
      return {
        dot: "bg-[#e92b2b]",
        text: "text-[#c81818]",
        bar: "bg-[#e92b2b]",
      };
    case "canceled":
    case "loading":
    case "idle":
      return {
        dot: "bg-[#7b8493]",
        text: "text-[#586273]",
        bar: "bg-[#7b8493]",
      };
    case "active":
      return {
        dot: "processing-dot-pulse bg-[#11131a]",
        text: "text-[#11131a]",
        bar: "bg-[#11131a]",
      };
  }
}

function getSubmitLabel(uploadItems: UploadProgressItem[]) {
  if (uploadItems.some((item) => item.phase === "creating")) {
    return "正在创建上传...";
  }

  if (uploadItems.some((item) => item.phase === "uploading")) {
    return "正在上传...";
  }

  if (uploadItems.some((item) => item.phase === "queueing")) {
    return "正在启动 AI 处理...";
  }

  return "处理中...";
}

function GlobeIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3c2.3 2.6 3.5 5.6 3.5 9S14.3 18.4 12 21" />
      <path d="M12 3c-2.3 2.6-3.5 5.6-3.5 9s1.2 6.4 3.5 9" />
    </svg>
  );
}

function ChevronDownIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      aria-hidden="true"
    >
      <path d="m5 8 5 5 5-5" />
    </svg>
  );
}

function PlayIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M8 5.4v13.2L18.5 12z" />
    </svg>
  );
}

function HelpIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M9.8 9a2.4 2.4 0 0 1 4.5 1.2c0 1.8-2.3 2-2.3 3.8" />
      <path d="M12 17h.01" />
    </svg>
  );
}

function UserIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <circle cx="12" cy="8" r="3.2" />
      <path d="M5.5 20a6.7 6.7 0 0 1 13 0" />
    </svg>
  );
}

function LogoMark() {
  return (
    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#ee2b2f] text-xl font-black text-white shadow-sm shadow-red-600/20">
      B
    </div>
  );
}

function FileThumb() {
  return (
    <div className="relative h-[58px] w-[70px] shrink-0 overflow-hidden rounded-lg bg-[#eef1f6]">
      <div className="absolute inset-0 flex items-center justify-center">
        <PlayIcon className="h-7 w-7 text-[#11131a]" />
      </div>
    </div>
  );
}

function RejectedFiles({ rejectedItems }: { rejectedItems: RejectedUploadItem[] }) {
  if (rejectedItems.length === 0) {
    return null;
  }

  return (
    <div className="grid gap-2" aria-live="polite">
      {rejectedItems.map((item) => (
        <div
          key={item.id}
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-3"
        >
          <p className="truncate text-sm font-semibold text-red-950">
            {item.filename}
          </p>
          <p className="mt-1 text-sm text-red-800">{item.error}</p>
        </div>
      ))}
    </div>
  );
}

function SelectedFiles({ selections }: { selections: UploadSelection[] }) {
  if (selections.length === 0) {
    return null;
  }

  return (
    <div className="rounded-lg border border-[#cfd5df] bg-white px-4 py-3 text-left">
      <p className="text-sm font-semibold text-[#11131a]">
        已选择 {selections.length} 个视频
      </p>
      <div className="mt-3 grid gap-2">
        {selections.map((selection) => (
          <div
            key={selection.id}
            className="grid grid-cols-[56px_minmax(0,1fr)] items-center gap-3"
          >
            <div className="flex aspect-video w-14 items-center justify-center rounded-md bg-[#eef1f6] text-[#11131a]">
              <PlayIcon className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-[#11131a]">
                {selection.filename}
              </p>
              <p className="text-xs text-[#6f7785]">
                {formatFileSize(selection.size)} · {selection.contentType}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatDateTime(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getHistoryStatusLabel(status: VideoJobHistoryItem["status"]) {
  switch (status) {
    case "active":
      return "处理中";
    case "completed":
      return "已完成";
    case "failed":
      return "有失败";
    case "created":
      return "待开始";
  }
}

function getHistoryStatusClasses(status: VideoJobHistoryItem["status"]) {
  switch (status) {
    case "completed":
      return "border-[#cbe8d1] bg-[#f0fbf2] text-[#198a35]";
    case "failed":
      return "border-red-200 bg-red-50 text-[#c81818]";
    case "active":
      return "border-[#d5dbe5] bg-[#f4f6fa] text-[#11131a]";
    case "created":
      return "border-[#dce1ea] bg-[#fbfcfe] text-[#586273]";
  }
}

export function AppHeader() {
  return (
    <header className="border-b border-[#d5dbe5] bg-white">
      <div className="flex h-16 items-center justify-between px-5 sm:px-8">
        <div className="flex min-w-0 items-center gap-4">
          <LogoMark />
          <div className="flex min-w-0 items-center gap-4">
            <p className="truncate text-2xl font-bold tracking-tight text-[#11131a]">
              Blooclip
            </p>
            <span className="hidden h-7 w-px bg-[#d5dbe5] sm:block" />
            <p className="hidden text-base font-medium text-[#586273] sm:block">
              AI 视频剪辑工具
            </p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <a
            href="#upload-progress"
            className="hidden text-sm font-semibold text-[#11131a] transition hover:text-[#ee2b2f] sm:inline"
          >
            上传进度
          </a>
          <button
            type="button"
            className="flex h-9 w-9 items-center justify-center rounded-full border border-[#aeb7c5] text-[#586273] transition hover:border-[#11131a] hover:text-[#11131a]"
            aria-label="帮助"
          >
            <HelpIcon className="h-5 w-5" />
          </button>
          <button
            type="button"
            className="flex h-9 w-9 items-center justify-center rounded-full border border-[#aeb7c5] text-[#586273] transition hover:border-[#11131a] hover:text-[#11131a]"
            aria-label="账户"
          >
            <UserIcon className="h-5 w-5" />
          </button>
        </div>
      </div>
    </header>
  );
}

type UploadFormProps = {
  prompt: string;
  targetLanguage: string;
  selectedUploads: UploadSelection[];
  rejectedItems: RejectedUploadItem[];
  uploadItems: UploadProgressItem[];
  formError: string | null;
  isDragging: boolean;
  isSubmitting: boolean;
  canGenerate: boolean;
  selectedTotalSize: number;
  onSubmit(event: FormEvent<HTMLFormElement>): void;
  onChooseVideos(event: ChangeEvent<HTMLInputElement>): void;
  onDragEnter(event: DragEvent<HTMLLabelElement>): void;
  onDragOver(event: DragEvent<HTMLLabelElement>): void;
  onDragLeave(event: DragEvent<HTMLLabelElement>): void;
  onDrop(event: DragEvent<HTMLLabelElement>): void;
  onPromptChange(value: string): void;
  onTargetLanguageChange(value: string): void;
};

export function UploadForm({
  prompt,
  targetLanguage,
  selectedUploads,
  rejectedItems,
  uploadItems,
  formError,
  isDragging,
  isSubmitting,
  canGenerate,
  selectedTotalSize,
  onSubmit,
  onChooseVideos,
  onDragEnter,
  onDragOver,
  onDragLeave,
  onDrop,
  onPromptChange,
  onTargetLanguageChange,
}: UploadFormProps) {
  return (
    <section className="px-4 py-8 sm:px-6 sm:py-9">
      <form
        onSubmit={onSubmit}
        className="mx-auto grid w-full max-w-[560px] gap-4"
      >
        <h1 className="text-center text-3xl font-bold tracking-tight text-[#11131a] sm:text-4xl">
          上传视频
        </h1>

        <label
          onDragEnter={onDragEnter}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          className={cx(
            "flex min-h-[70px] items-center justify-center rounded-lg border border-dashed px-4 text-base font-medium transition",
            isSubmitting
              ? "cursor-not-allowed border-[#cbd2dd] bg-[#eef1f6] text-[#8a93a3]"
              : isDragging
                ? "cursor-pointer border-[#ee2b2f] bg-red-50 text-[#ee2b2f]"
                : "cursor-pointer border-[#b9c2d0] bg-white/55 text-[#586273] hover:border-[#ee2b2f] hover:text-[#ee2b2f]"
          )}
        >
          <input
            type="file"
            multiple
            accept={UPLOAD_ACCEPT_ATTRIBUTE}
            onChange={onChooseVideos}
            disabled={isSubmitting}
            className="sr-only"
          />
          将视频拖到这里/点击选择视频上传
        </label>

        <SelectedFiles selections={selectedUploads} />

        {selectedUploads.length > 0 && (
          <p className="text-center text-sm font-medium text-[#586273]">
            已选择总大小：{formatFileSize(selectedTotalSize)}
          </p>
        )}

        <RejectedFiles rejectedItems={rejectedItems} />

        {formError && (
          <div
            className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-900"
            role="alert"
          >
            {formError}
          </div>
        )}

        <div className="grid gap-2 text-left">
          <label
            htmlFor="prompt"
            className="text-base font-bold text-[#11131a]"
          >
            提示词
          </label>
          <textarea
            id="prompt"
            value={prompt}
            onChange={(event) => onPromptChange(event.target.value)}
            rows={4}
            required
            disabled={isSubmitting}
            placeholder="详细描述您的视频内容，AI视频生成的效果会更好哦！"
            className="min-h-[94px] resize-none rounded-lg border border-[#c5ccd8] bg-white px-4 py-3 text-base leading-6 text-[#11131a] outline-none transition placeholder:text-[#7b8493] focus:border-[#11131a] focus:ring-4 focus:ring-[#11131a]/5 disabled:cursor-not-allowed disabled:bg-[#eef1f6] disabled:text-[#6f7785]"
          />
        </div>

        <div className="grid gap-2 text-left">
          <label
            htmlFor="target-language"
            className="text-base font-bold text-[#11131a]"
          >
            目标语言
          </label>
          <div className="relative">
            <GlobeIcon className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-[#586273]" />
            <select
              id="target-language"
              value={targetLanguage}
              onChange={(event) => onTargetLanguageChange(event.target.value)}
              disabled={isSubmitting}
              className="h-[52px] w-full appearance-none rounded-lg border border-[#c5ccd8] bg-white px-12 text-base font-medium text-[#11131a] outline-none transition focus:border-[#11131a] focus:ring-4 focus:ring-[#11131a]/5 disabled:cursor-not-allowed disabled:bg-[#eef1f6] disabled:text-[#6f7785]"
            >
              {TARGET_LANGUAGE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <ChevronDownIcon className="pointer-events-none absolute right-4 top-1/2 h-5 w-5 -translate-y-1/2 text-[#11131a]" />
          </div>
        </div>

        <button
          type="submit"
          disabled={!canGenerate}
          className="mt-1 h-[52px] rounded-lg bg-[#090a0d] px-6 text-base font-bold text-white shadow-sm shadow-black/20 transition hover:bg-black focus:outline-none focus:ring-4 focus:ring-black/15 disabled:cursor-not-allowed disabled:bg-[#aeb7c5] disabled:shadow-none"
        >
          {isSubmitting ? getSubmitLabel(uploadItems) : "生成"}
        </button>
      </form>
    </section>
  );
}

type RecentJobsProps = {
  items: VideoJobHistoryItem[];
  isLoading: boolean;
  message: string | null;
  activeBatchId: string | null;
  onSelect(batchId: string): void;
};

export function RecentJobs({
  items,
  isLoading,
  message,
  activeBatchId,
  onSelect,
}: RecentJobsProps) {
  if (isLoading && items.length === 0) {
    return (
      <section className="border-t border-[#d5dbe5] bg-white px-4 py-5 sm:px-8">
        <div className="mx-auto max-w-[1100px]">
          <h2 className="text-2xl font-bold tracking-tight text-[#11131a]">
            最近任务
          </h2>
          <p className="mt-2 text-sm font-medium text-[#6f7785]">
            正在加载最近任务...
          </p>
        </div>
      </section>
    );
  }

  if (items.length === 0 && !message) {
    return null;
  }

  return (
    <section className="border-t border-[#d5dbe5] bg-white px-4 py-5 sm:px-8">
      <div className="mx-auto max-w-[1100px]">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-2xl font-bold tracking-tight text-[#11131a]">
              最近任务
            </h2>
            {message && (
              <p className="mt-1 text-sm font-medium text-[#c81818]">
                {message}
              </p>
            )}
          </div>
        </div>

        {items.length > 0 && (
          <div className="mt-3 overflow-hidden rounded-lg border border-[#cfd6e1] bg-white">
            <ul aria-live="polite">
              {items.map((item) => {
                const isActive = item.id === activeBatchId;

                return (
                  <li
                    key={item.id}
                    className="grid gap-4 border-t border-[#dce1ea] px-4 py-4 first:border-t-0 md:grid-cols-[minmax(0,1fr)_180px_120px] md:items-center md:gap-5"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-bold text-[#11131a]">
                          {item.title}
                        </p>
                        <span
                          className={cx(
                            "rounded border px-2 py-0.5 text-xs font-semibold",
                            getHistoryStatusClasses(item.status)
                          )}
                        >
                          {getHistoryStatusLabel(item.status)}
                        </span>
                      </div>
                      <p className="mt-1 text-sm text-[#6f7785]">
                        视频 {item.videoCount}/{item.expectedVideoCount} · 已完成{" "}
                        {item.completedCount} · 失败 {item.failedCount}
                      </p>
                    </div>

                    <p className="text-sm font-medium text-[#6f7785]">
                      更新 {formatDateTime(item.updatedAt)}
                    </p>

                    <button
                      type="button"
                      onClick={() => onSelect(item.id)}
                      disabled={isActive}
                      className="h-9 rounded-md border border-[#c5ccd8] bg-white px-3 text-sm font-semibold text-[#11131a] transition hover:border-[#11131a] disabled:cursor-default disabled:border-[#11131a] disabled:bg-[#11131a] disabled:text-white"
                    >
                      {isActive ? "已打开" : "打开"}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

type UploadProgressListProps = {
  items: UploadProgressItem[];
  batchStatus: BatchStatus | null;
  statusMessage: string | null;
  downloadingVideoId: string | null;
  downloadingInstructionPdfId: string | null;
  retryingVideoId: string | null;
  onDownloadVideo(videoId: string): void;
  onDownloadInstructionPdf(videoId: string): void;
  onRetryProcessing(videoId: string): void;
};

export function UploadProgressList({
  items,
  batchStatus,
  statusMessage,
  downloadingVideoId,
  downloadingInstructionPdfId,
  retryingVideoId,
  onDownloadVideo,
  onDownloadInstructionPdf,
  onRetryProcessing,
}: UploadProgressListProps) {
  const rows =
    items.length > 0
      ? items
      : (batchStatus?.videos ?? []).map((video) => ({
          id: video.id,
          videoId: video.id,
          filename: video.filename ?? "未命名视频",
          contentType: video.contentType ?? "",
          size: video.size ?? 0,
          phase: "queueing" as UploadPhase,
          progress: video.progress,
          message: "已载入任务",
        }));

  if (rows.length === 0) {
    return null;
  }

  const videosById = new Map(
    (batchStatus?.videos ?? []).map((video) => [video.id, video])
  );
  const counts = getBatchCounts(batchStatus);

  return (
    <section
      id="upload-progress"
      className="border-t border-[#d5dbe5] bg-white px-4 py-5 sm:px-8"
    >
      <div className="mx-auto max-w-[1100px]">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-2xl font-bold tracking-tight text-[#11131a]">
              {batchStatus ? "处理结果" : "上传进度"}
            </h2>
            {statusMessage && (
              <p className="mt-1 text-sm font-medium text-[#6f7785]">
                {statusMessage}
              </p>
            )}
          </div>

          {batchStatus && (
            <div className="flex flex-wrap gap-2 text-sm font-semibold">
              <span className="rounded border border-[#dce1ea] bg-[#fbfcfe] px-2.5 py-1 text-[#586273]">
                视频 {counts.videoCount}/{counts.totalCount}
              </span>
              <span className="rounded border border-[#dce1ea] bg-[#fbfcfe] px-2.5 py-1 text-[#586273]">
                进行中 {counts.activeCount}
              </span>
              <span className="rounded border border-[#dce1ea] bg-[#fbfcfe] px-2.5 py-1 text-[#198a35]">
                已完成 {counts.completedCount}
              </span>
              <span className="rounded border border-[#dce1ea] bg-[#fbfcfe] px-2.5 py-1 text-[#c81818]">
                失败 {counts.failedCount}
              </span>
            </div>
          )}
        </div>

        <div className="mt-3 overflow-hidden rounded-lg border border-[#cfd6e1] bg-white">
          <div className="hidden grid-cols-[minmax(0,1fr)_220px_190px_170px] gap-5 border-b border-[#dce1ea] bg-[#fbfcfe] px-4 py-3 text-sm font-semibold text-[#586273] md:grid">
            <span>视频</span>
            <span>状态</span>
            <span>进度</span>
            <span>操作</span>
          </div>

          <ul aria-live="polite">
            {rows.map((item) => {
              const batchVideo = item.videoId ? videosById.get(item.videoId) : null;
              const filename = batchVideo?.filename ?? item.filename;
              const contentType = batchVideo?.contentType ?? item.contentType;
              const size = batchVideo?.size ?? item.size;
              const display = batchVideo
                ? getProcessingDisplay({
                    status: batchVideo.status,
                    currentStage: batchVideo.currentStage,
                    progress: batchVideo.progress,
                    errorMessage: batchVideo.errorMessage,
                  })
                : null;
              const tone = display
                ? getProcessingListClasses(display.tone)
                : getPhaseClasses(item.phase);
              const progress = Math.max(
                0,
                Math.min(100, display ? display.progress : item.progress)
              );
              const statusTitle = display
                ? display.title
                : getPhaseLabel(item.phase);
              const statusDetail =
                display?.detail ?? batchVideo?.errorMessage ?? item.message;
              const canDownloadVideo = Boolean(batchVideo?.downloadReady);
              const canDownloadInstructionPdf = Boolean(
                batchVideo?.instructionPdfReady
              );
              const isDownloadingVideo = batchVideo?.id === downloadingVideoId;
              const isDownloadingInstructionPdf =
                batchVideo?.id === downloadingInstructionPdfId;
              const canRetryProcessing = Boolean(
                batchVideo?.status === "failed" && batchVideo.retryable
              );
              const isRetryingProcessing = batchVideo?.id === retryingVideoId;

              return (
                <li
                  key={item.id}
                  className="grid gap-4 border-t border-[#dce1ea] px-4 py-4 first:border-t-0 md:grid-cols-[minmax(0,1fr)_220px_190px_170px] md:items-center md:gap-5"
                >
                  <div className="grid min-w-0 grid-cols-[70px_minmax(0,1fr)] items-center gap-4">
                    <FileThumb />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-bold text-[#11131a]">
                        {filename}
                      </p>
                      <p className="mt-1 text-sm text-[#6f7785]">
                        {formatVideoMeta(size, contentType)}
                      </p>
                    </div>
                  </div>

                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={cx("h-2.5 w-2.5 rounded-full", tone.dot)} />
                      <span className={cx("text-sm font-semibold", tone.text)}>
                        {statusTitle}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-sm leading-5 text-[#6f7785]">
                      {statusDetail}
                    </p>
                  </div>

                  <div className="grid grid-cols-[44px_1fr] items-center gap-3">
                    <span className="font-mono text-sm font-semibold text-[#11131a]">
                      {item.phase === "creating" ? "-" : `${progress}%`}
                    </span>
                    <div className="h-2 overflow-hidden rounded-full bg-[#e2e6ed]">
                      <div
                        className={cx(
                          "h-full rounded-full transition-all duration-500",
                          tone.bar
                        )}
                        style={{
                          width: `${
                            !display && item.phase === "creating" ? 0 : progress
                          }%`,
                        }}
                      />
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2 md:grid">
                    {canDownloadVideo && batchVideo && (
                      <button
                        type="button"
                        onClick={() => onDownloadVideo(batchVideo.id)}
                        disabled={isDownloadingVideo}
                        className="h-9 rounded-md bg-[#11131a] px-3 text-sm font-semibold text-white transition hover:bg-black disabled:cursor-not-allowed disabled:bg-[#aeb7c5]"
                      >
                        {isDownloadingVideo ? "准备中..." : "下载最终视频"}
                      </button>
                    )}

                    {canDownloadInstructionPdf && batchVideo && (
                      <button
                        type="button"
                        onClick={() => onDownloadInstructionPdf(batchVideo.id)}
                        disabled={isDownloadingInstructionPdf}
                        className="h-9 rounded-md border border-[#c5ccd8] bg-white px-3 text-sm font-semibold text-[#11131a] transition hover:border-[#11131a] disabled:cursor-not-allowed disabled:text-[#8a93a3]"
                      >
                        {isDownloadingInstructionPdf
                          ? "准备中..."
                          : "下载操作 PDF"}
                      </button>
                    )}

                    {canRetryProcessing && batchVideo && (
                      <button
                        type="button"
                        onClick={() => onRetryProcessing(batchVideo.id)}
                        disabled={isRetryingProcessing}
                        className="h-9 rounded-md bg-[#ee2b2f] px-3 text-sm font-semibold text-white transition hover:bg-[#c81818] disabled:cursor-not-allowed disabled:bg-[#aeb7c5]"
                      >
                        {isRetryingProcessing ? "启动中..." : "重试处理"}
                      </button>
                    )}

                    {!canDownloadVideo &&
                      !canDownloadInstructionPdf &&
                      !canRetryProcessing && (
                        <span className="text-sm font-medium text-[#8a93a3]">
                          等待结果
                        </span>
                      )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </section>
  );
}
