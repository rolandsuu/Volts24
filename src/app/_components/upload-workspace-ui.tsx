import Link from "next/link";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type ReactNode,
} from "react";

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

function UploadStepIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
    >
      <rect
        x="8"
        y="12"
        width="32"
        height="24"
        rx="4"
        className="fill-white stroke-current"
        strokeWidth="2"
      />
      <path
        d="M24 30V18m0 0-5 5m5-5 5 5"
        className="stroke-current"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2.4"
      />
      <path
        d="M16 34h16"
        className="stroke-current"
        strokeLinecap="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function PromptStepIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
    >
      <rect
        x="9"
        y="10"
        width="30"
        height="28"
        rx="4"
        className="fill-white stroke-current"
        strokeWidth="2"
      />
      <path
        d="M16 18h16M16 24h12M16 30h9"
        className="stroke-current"
        strokeLinecap="round"
        strokeWidth="2.4"
      />
      <path
        d="M31.5 29.5 36 34"
        className="stroke-current"
        strokeLinecap="round"
        strokeWidth="2.4"
      />
    </svg>
  );
}

function LanguageStepIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="24"
        cy="24"
        r="15"
        className="fill-white stroke-current"
        strokeWidth="2"
      />
      <path
        d="M10 24h28M24 9c4 4.4 6 9.4 6 15s-2 10.6-6 15M24 9c-4 4.4-6 9.4-6 15s2 10.6 6 15"
        className="stroke-current"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function GenerateStepIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
    >
      <rect
        x="8"
        y="14"
        width="32"
        height="22"
        rx="4"
        className="fill-white stroke-current"
        strokeWidth="2"
      />
      <path d="M21 20v10l8-5z" className="fill-current" />
      <path
        d="M35 9v6M32 12h6M12 9v4M10 11h4"
        className="stroke-current"
        strokeLinecap="round"
        strokeWidth="2.2"
      />
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

const HELP_TUTORIAL_STEPS = [
  {
    title: "上传视频",
    description: "点击上传区域，或把视频拖进去。",
    Icon: UploadStepIcon,
  },
  {
    title: "写提示词",
    description: "简单说明你想让 AI 剪出什么效果。",
    Icon: PromptStepIcon,
  },
  {
    title: "选择语言",
    description: "选择最终视频和说明文档的语言。",
    Icon: LanguageStepIcon,
  },
  {
    title: "一键剪辑",
    description: "等待处理完成后下载视频或操作 PDF。",
    Icon: GenerateStepIcon,
  },
] as const;

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

type AppHeaderProps = {
  navLink?: {
    href: string;
    label: string;
  };
};

export function AppHeader({
  navLink = {
    href: "/history",
    label: "历史任务",
  },
}: AppHeaderProps) {
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const helpPanelId = useId();
  const helpWrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isHelpOpen) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsHelpOpen(false);
      }
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target;

      if (
        target instanceof Node &&
        !helpWrapRef.current?.contains(target)
      ) {
        setIsHelpOpen(false);
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("pointerdown", handlePointerDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [isHelpOpen]);

  return (
    <header className="relative z-20 border-b border-[#d5dbe5] bg-white">
      <div className="flex h-16 items-center justify-between px-5 sm:px-8">
        <div className="flex min-w-0 items-center gap-4">
          <div className="flex min-w-0 items-center gap-4">
            <p className="truncate text-2xl font-bold tracking-tight text-[#11131a]">
              Volts24
            </p>
            <span className="hidden h-7 w-px bg-[#d5dbe5] sm:block" />
            <p className="hidden text-base font-medium text-[#586273] sm:block">
              AI 视频剪辑工具
            </p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <Link
            href={navLink.href}
            className="hidden text-sm font-semibold text-[#11131a] transition hover:text-[#ee2b2f] sm:inline"
          >
            {navLink.label}
          </Link>
          <div ref={helpWrapRef} className="relative">
            <button
              type="button"
              className={cx(
                "flex h-9 w-9 items-center justify-center rounded-full border transition hover:border-[#11131a] hover:text-[#11131a] focus:outline-none focus:ring-4 focus:ring-[#11131a]/10",
                isHelpOpen
                  ? "border-[#11131a] bg-[#11131a] text-white"
                  : "border-[#aeb7c5] text-[#586273]"
              )}
              aria-label="帮助"
              aria-expanded={isHelpOpen}
              aria-controls={helpPanelId}
              onClick={() => setIsHelpOpen((current) => !current)}
            >
              <HelpIcon className="h-5 w-5" />
            </button>

            {isHelpOpen && (
              <div
                id={helpPanelId}
                role="dialog"
                aria-label="怎么使用 Volts24"
                className="absolute right-[-56px] top-12 w-[min(calc(100vw-2rem),360px)] rounded-lg border border-[#d5dbe5] bg-white p-4 text-left text-[#11131a] shadow-[0_18px_45px_rgba(17,19,26,0.16)] sm:right-0"
              >
                <div className="absolute right-[67px] top-[-7px] h-3.5 w-3.5 rotate-45 border-l border-t border-[#d5dbe5] bg-white sm:right-3" />
                <div className="relative">
                  <p className="text-base font-bold text-[#11131a]">
                    怎么使用 Volts24
                  </p>
                  <div className="mt-3 grid gap-3">
                    {HELP_TUTORIAL_STEPS.map((step, index) => (
                      <div
                        key={step.title}
                        className="grid grid-cols-[48px_minmax(0,1fr)] gap-3"
                      >
                        <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-[#f4f6fa] text-[#11131a]">
                          <step.Icon className="h-9 w-9" />
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-bold text-[#11131a]">
                            {index + 1}. {step.title}
                          </p>
                          <p className="mt-1 text-sm leading-5 text-[#586273]">
                            {step.description}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
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
          {isSubmitting ? getSubmitLabel(uploadItems) : "一键剪辑"}
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
  activeContent?: ReactNode;
  showEmptyState?: boolean;
  onSelect(batchId: string): void;
};

export function RecentJobs({
  items,
  isLoading,
  message,
  activeBatchId,
  activeContent,
  showEmptyState = false,
  onSelect,
}: RecentJobsProps) {
  if (isLoading && items.length === 0) {
    return (
      <section className="border-t border-[#d5dbe5] bg-white px-4 py-5 sm:px-8">
        <div className="mx-auto max-w-[1100px]">
          <h2 className="text-2xl font-bold tracking-tight text-[#11131a]">
            历史任务
          </h2>
          <p className="mt-2 text-sm font-medium text-[#6f7785]">
            正在加载历史任务...
          </p>
        </div>
      </section>
    );
  }

  if (items.length === 0 && !message && !showEmptyState) {
    return null;
  }

  return (
    <section className="border-t border-[#d5dbe5] bg-white px-4 py-5 sm:px-8">
      <div className="mx-auto max-w-[1100px]">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-2xl font-bold tracking-tight text-[#11131a]">
              历史任务
            </h2>
            {message && (
              <p className="mt-1 text-sm font-medium text-[#c81818]">
                {message}
              </p>
            )}
          </div>
        </div>

        {items.length === 0 && !message && (
          <div className="mt-3 rounded-lg border border-[#cfd6e1] bg-[#fbfcfe] px-4 py-5 text-sm font-medium text-[#6f7785]">
            最近 7 天没有历史任务。
          </div>
        )}

        {items.length > 0 && (
          <div className="mt-3 overflow-hidden rounded-lg border border-[#cfd6e1] bg-white">
            <ul aria-live="polite">
              {items.map((item) => {
                const isActive = item.id === activeBatchId;
                const drawerId = `history-drawer-${item.id}`;

                return (
                  <li
                    key={item.id}
                    className="border-t border-[#dce1ea] first:border-t-0"
                  >
                    <button
                      type="button"
                      aria-expanded={isActive}
                      aria-controls={drawerId}
                      onClick={() => onSelect(item.id)}
                      className={cx(
                        "grid w-full gap-4 px-4 py-4 text-left transition focus:outline-none focus:ring-4 focus:ring-inset focus:ring-[#11131a]/10 md:grid-cols-[minmax(0,1fr)_180px_32px] md:items-center md:gap-5",
                        isActive
                          ? "bg-[#f4f6fa]"
                          : "bg-white hover:bg-[#fbfcfe]"
                      )}
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

                      <span
                        className={cx(
                          "flex h-8 w-8 items-center justify-center rounded-full border border-[#c5ccd8] text-[#586273] transition justify-self-start md:justify-self-end",
                          isActive && "border-[#11131a] bg-[#11131a] text-white"
                        )}
                        aria-hidden="true"
                      >
                        <ChevronDownIcon
                          className={cx(
                            "h-4 w-4 transition-transform",
                            isActive && "rotate-180"
                          )}
                        />
                      </span>
                    </button>

                    {isActive && activeContent && (
                      <div
                        id={drawerId}
                        className="border-t border-[#dce1ea] bg-[#fbfcfe] px-4 py-4 sm:px-5"
                      >
                        {activeContent}
                      </div>
                    )}
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
  layout?: "section" | "drawer";
};

type UploadProgressRowsProps = Omit<
  UploadProgressListProps,
  "items" | "statusMessage" | "layout"
> & {
  rows: UploadProgressItem[];
  className?: string;
};

function UploadProgressRows({
  rows,
  batchStatus,
  downloadingVideoId,
  downloadingInstructionPdfId,
  retryingVideoId,
  onDownloadVideo,
  onDownloadInstructionPdf,
  onRetryProcessing,
  className,
}: UploadProgressRowsProps) {
  const videosById = new Map(
    (batchStatus?.videos ?? []).map((video) => [video.id, video])
  );

  return (
    <div
      className={cx(
        "overflow-hidden rounded-lg border border-[#cfd6e1] bg-white",
        className
      )}
    >
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
          const statusTitle = display ? display.title : getPhaseLabel(item.phase);
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
                    {isDownloadingInstructionPdf ? "准备中..." : "下载操作 PDF"}
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
  );
}

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
  layout = "section",
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
    if (layout === "drawer" && statusMessage) {
      return (
        <div
          className="rounded-lg border border-[#cfd6e1] bg-white px-4 py-3 text-sm font-medium text-[#6f7785]"
          role="status"
        >
          {statusMessage}
        </div>
      );
    }

    return null;
  }

  const counts = getBatchCounts(batchStatus);
  const countBadges = batchStatus ? (
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
  ) : null;

  if (layout === "drawer") {
    return (
      <div className="grid gap-3">
        {(statusMessage || countBadges) && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            {statusMessage && (
              <p className="text-sm font-medium text-[#6f7785]">
                {statusMessage}
              </p>
            )}
            {countBadges}
          </div>
        )}

        <UploadProgressRows
          rows={rows}
          batchStatus={batchStatus}
          downloadingVideoId={downloadingVideoId}
          downloadingInstructionPdfId={downloadingInstructionPdfId}
          retryingVideoId={retryingVideoId}
          onDownloadVideo={onDownloadVideo}
          onDownloadInstructionPdf={onDownloadInstructionPdf}
          onRetryProcessing={onRetryProcessing}
        />
      </div>
    );
  }

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

          {countBadges}
        </div>

        <UploadProgressRows
          rows={rows}
          batchStatus={batchStatus}
          downloadingVideoId={downloadingVideoId}
          downloadingInstructionPdfId={downloadingInstructionPdfId}
          retryingVideoId={retryingVideoId}
          onDownloadVideo={onDownloadVideo}
          onDownloadInstructionPdf={onDownloadInstructionPdf}
          onRetryProcessing={onRetryProcessing}
          className="mt-3"
        />
      </div>
    </section>
  );
}
