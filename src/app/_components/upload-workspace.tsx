"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";

import {
  DEFAULT_TARGET_LANGUAGE,
  TARGET_LANGUAGE_OPTIONS,
} from "@/lib/languages";
import {
  prepareClientUploadFiles,
  type PreparedClientUploadFile,
} from "@/lib/client-upload";

type RejectedUploadItem = {
  id: string;
  filename: string;
  error: string;
};

type UploadAttachment = PreparedClientUploadFile<File> & {
  id: string;
  previewUrl: string;
};

type ConversationMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
  attachments?: UploadAttachment[];
};

type ChatPhase =
  | "idle"
  | "clarifying"
  | "planned"
  | "editing"
  | "processing"
  | "complete";

type MockTimelineStep = {
  id: string;
  title: string;
  detail: string;
};

type MockPlan = {
  objective: string;
  targetLanguage: string;
  targetLanguageLabel: string;
  files: string[];
  steps: MockTimelineStep[];
  outputs: string[];
};

const UPLOAD_ACCEPT_ATTRIBUTE =
  "video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov";

const TIMELINE_STEPS: MockTimelineStep[] = [
  {
    id: "uploading",
    title: "uploading",
    detail: "Stage local video attachments for the mock task.",
  },
  {
    id: "analyzing-video",
    title: "analyzing video",
    detail: "Review scenes, motion, and the strongest tutorial moments.",
  },
  {
    id: "extracting-transcript",
    title: "extracting transcript",
    detail: "Build a working transcript from speech and visible context.",
  },
  {
    id: "generating-edit-plan",
    title: "generating edit plan",
    detail: "Choose the narrative structure, clips, and pacing.",
  },
  {
    id: "creating-subtitles",
    title: "creating subtitles",
    detail: "Create readable subtitle cues in the selected language.",
  },
  {
    id: "rendering-video",
    title: "rendering video",
    detail: "Assemble the mock final video preview.",
  },
  {
    id: "generating-tutorial-document",
    title: "generating tutorial document",
    detail: "Draft a step-by-step tutorial document from the plan.",
  },
  {
    id: "generating-webpage",
    title: "generating webpage",
    detail: "Prepare a shareable tutorial webpage artifact.",
  },
];

const MOCK_OUTPUTS = [
  "video preview",
  "transcript",
  "subtitles",
  "document",
  "webpage link",
];

const INITIAL_MESSAGES: ConversationMessage[] = [
  {
    id: "welcome",
    role: "assistant",
    text:
      "Upload one or more videos, add a prompt, and I will draft a plan before any processing starts.",
  },
];

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

function formatFileSize(bytes: number) {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function pluralizeVideo(count: number) {
  return count === 1 ? "video" : "videos";
}

function getUploadItemId(file: File, index: number) {
  return `${file.name}-${file.size}-${file.lastModified}-${index}`;
}

function getMessageId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getTargetLanguageLabel(value: string) {
  return (
    TARGET_LANGUAGE_OPTIONS.find((option) => option.value === value)?.label ??
    value
  );
}

function createMockPlan(options: {
  objective: string;
  targetLanguage: string;
  attachments: UploadAttachment[];
}): MockPlan {
  return {
    objective:
      options.objective.trim() ||
      "Create a concise tutorial from the uploaded videos.",
    targetLanguage: options.targetLanguage,
    targetLanguageLabel: getTargetLanguageLabel(options.targetLanguage),
    files: options.attachments.map((attachment) => attachment.filename),
    steps: TIMELINE_STEPS,
    outputs: MOCK_OUTPUTS,
  };
}

function RoleAvatar({ role }: { role: ConversationMessage["role"] }) {
  return (
    <div
      className={cx(
        "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-xs font-semibold",
        role === "assistant"
          ? "border border-black bg-black text-white"
          : "border border-black/10 bg-white text-black"
      )}
    >
      {role === "assistant" ? "AI" : "You"}
    </div>
  );
}

function AttachmentCard({ attachment }: { attachment: UploadAttachment }) {
  return (
    <div className="grid min-w-0 gap-2 rounded-md border border-black/10 bg-white p-3 sm:grid-cols-[72px_minmax(0,1fr)]">
      <video
        src={attachment.previewUrl}
        className="aspect-video w-full rounded bg-black object-cover sm:w-[72px]"
        muted
        playsInline
        preload="metadata"
      />
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{attachment.filename}</p>
        <p className="mt-1 text-xs text-black/50">
          {formatFileSize(attachment.size)} · {attachment.contentType}
        </p>
        <p className="mt-1 text-xs text-black/45">Attached to conversation</p>
      </div>
    </div>
  );
}

function RejectedFiles({ rejectedItems }: { rejectedItems: RejectedUploadItem[] }) {
  if (rejectedItems.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2">
      {rejectedItems.map((item) => (
        <div
          key={item.id}
          className="rounded-md border border-red-200 bg-red-50 p-3"
        >
          <p className="truncate text-sm font-medium text-red-950">
            {item.filename}
          </p>
          <p className="mt-1 text-sm text-red-800">{item.error}</p>
        </div>
      ))}
    </div>
  );
}

function ConversationMessageRow({ message }: { message: ConversationMessage }) {
  const isUser = message.role === "user";

  return (
    <div
      className={cx(
        "flex gap-3",
        isUser ? "justify-end" : "justify-start"
      )}
    >
      {!isUser && <RoleAvatar role={message.role} />}
      <div
        className={cx(
          "max-w-[760px] space-y-3",
          isUser ? "order-first w-full sm:w-auto" : "min-w-0 flex-1"
        )}
      >
        <div
          className={cx(
            "rounded-md px-4 py-3 text-sm leading-6",
            isUser
              ? "ml-auto max-w-[760px] bg-black text-white"
              : "border border-black/10 bg-white text-black shadow-sm shadow-black/[0.02]"
          )}
        >
          {message.text}
        </div>

        {message.attachments && message.attachments.length > 0 && (
          <div className="grid gap-2">
            {message.attachments.map((attachment) => (
              <AttachmentCard key={attachment.id} attachment={attachment} />
            ))}
          </div>
        )}
      </div>
      {isUser && <RoleAvatar role={message.role} />}
    </div>
  );
}

function PlanCard({
  plan,
  phase,
  editPlanText,
  onEditPlanTextChange,
  onStartEdit,
  onSaveEdit,
  onApprove,
}: {
  plan: MockPlan;
  phase: ChatPhase;
  editPlanText: string;
  onEditPlanTextChange(value: string): void;
  onStartEdit(): void;
  onSaveEdit(): void;
  onApprove(): void;
}) {
  const isEditing = phase === "editing";
  const canAct = phase === "planned" || phase === "editing";

  return (
    <div className="flex gap-3">
      <RoleAvatar role="assistant" />
      <section className="w-full max-w-[760px] rounded-md border border-black/10 bg-white p-4 shadow-sm shadow-black/[0.03]">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-medium uppercase text-black/45">
              Structured plan
            </p>
            <h2 className="mt-1 text-lg font-semibold tracking-tight">
              Tutorial generation plan
            </h2>
          </div>
          <span className="rounded border border-black/10 px-2 py-1 text-xs font-medium text-black/55">
            Mock
          </span>
        </div>

        <div className="mt-4 grid gap-4">
          <div>
            <p className="text-sm font-medium">Objective</p>
            {isEditing ? (
              <textarea
                value={editPlanText}
                onChange={(event) => onEditPlanTextChange(event.target.value)}
                rows={3}
                className="mt-2 w-full resize-none rounded-md border border-black/15 px-3 py-2 text-sm leading-6 outline-none focus:border-black"
              />
            ) : (
              <p className="mt-1 text-sm leading-6 text-black/60">
                {plan.objective}
              </p>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-md border border-black/10 p-3">
              <p className="text-xs font-medium uppercase text-black/45">
                Videos
              </p>
              <p className="mt-1 text-sm font-medium">
                {plan.files.length} {pluralizeVideo(plan.files.length)}
              </p>
              <p className="mt-1 truncate text-xs text-black/45">
                {plan.files.join(", ")}
              </p>
            </div>
            <div className="rounded-md border border-black/10 p-3">
              <p className="text-xs font-medium uppercase text-black/45">
                Target language
              </p>
              <p className="mt-1 text-sm font-medium">
                {plan.targetLanguageLabel}
              </p>
              <p className="mt-1 text-xs text-black/45">
                Stored as {plan.targetLanguage}
              </p>
            </div>
          </div>

          <div>
            <p className="text-sm font-medium">Timeline</p>
            <div className="mt-2 grid gap-2">
              {plan.steps.map((step, index) => (
                <div
                  key={step.id}
                  className="grid grid-cols-[auto_1fr] gap-3 rounded-md border border-black/10 p-3"
                >
                  <span className="flex h-6 w-6 items-center justify-center rounded bg-black text-xs font-semibold text-white">
                    {index + 1}
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{step.title}</p>
                    <p className="mt-1 text-xs leading-5 text-black/50">
                      {step.detail}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div>
            <p className="text-sm font-medium">Expected outputs</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {plan.outputs.map((output) => (
                <span
                  key={output}
                  className="rounded border border-black/10 px-2 py-1 text-xs font-medium text-black/55"
                >
                  {output}
                </span>
              ))}
            </div>
          </div>
        </div>

        {canAct && (
          <div className="mt-4 flex flex-wrap gap-2 border-t border-black/10 pt-4">
            {isEditing ? (
              <button
                type="button"
                onClick={onSaveEdit}
                className="h-9 rounded-md bg-black px-3 text-sm font-semibold text-white transition hover:bg-black/80"
              >
                Save edits
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={onApprove}
                  className="h-9 rounded-md bg-black px-3 text-sm font-semibold text-white transition hover:bg-black/80"
                >
                  Approve plan
                </button>
                <button
                  type="button"
                  onClick={onStartEdit}
                  className="h-9 rounded-md border border-black/15 px-3 text-sm font-medium transition hover:border-black"
                >
                  Edit plan
                </button>
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function TimelineCard({
  steps,
  activeStepIndex,
}: {
  steps: MockTimelineStep[];
  activeStepIndex: number;
}) {
  return (
    <div className="flex gap-3">
      <RoleAvatar role="assistant" />
      <section className="w-full max-w-[760px] rounded-md border border-black/10 bg-white p-4 shadow-sm shadow-black/[0.03]">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-medium uppercase text-black/45">
              Processing timeline
            </p>
            <h2 className="mt-1 text-lg font-semibold tracking-tight">
              Running approved plan
            </h2>
          </div>
          <span className="rounded border border-black/10 px-2 py-1 text-xs font-medium text-black/55">
            {Math.min(activeStepIndex, steps.length)}/{steps.length}
          </span>
        </div>

        <div className="mt-4 grid gap-2">
          {steps.map((step, index) => {
            const isComplete = activeStepIndex > index;
            const isActive = activeStepIndex === index;

            return (
              <div
                key={step.id}
                className={cx(
                  "grid grid-cols-[auto_1fr_auto] items-start gap-3 rounded-md border p-3",
                  isActive
                    ? "border-black bg-black text-white"
                    : "border-black/10 bg-white text-black"
                )}
              >
                <span
                  className={cx(
                    "mt-1 h-2.5 w-2.5 rounded-full",
                    isComplete
                      ? "bg-black"
                      : isActive
                        ? "processing-dot-pulse bg-white"
                        : "bg-black/25"
                  )}
                  aria-hidden="true"
                />
                <div className="min-w-0">
                  <p className="text-sm font-medium">{step.title}</p>
                  <p
                    className={cx(
                      "mt-1 text-xs leading-5",
                      isActive ? "text-white/70" : "text-black/50"
                    )}
                  >
                    {step.detail}
                  </p>
                </div>
                <span
                  className={cx(
                    "text-xs font-medium",
                    isActive ? "text-white/70" : "text-black/45"
                  )}
                >
                  {isComplete ? "done" : isActive ? "running" : "queued"}
                </span>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function ArtifactCard({
  plan,
  firstAttachment,
}: {
  plan: MockPlan;
  firstAttachment: UploadAttachment | null;
}) {
  return (
    <div className="flex gap-3">
      <RoleAvatar role="assistant" />
      <section className="w-full max-w-[880px] rounded-md border border-black/10 bg-white p-4 shadow-sm shadow-black/[0.03]">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-medium uppercase text-black/45">
              Final artifacts
            </p>
            <h2 className="mt-1 text-lg font-semibold tracking-tight">
              Mock outputs are ready
            </h2>
          </div>
          <span className="rounded border border-black/10 px-2 py-1 text-xs font-medium text-black/55">
            Frontend only
          </span>
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          <div className="rounded-md border border-black/10 p-3">
            <p className="text-sm font-medium">Video preview</p>
            <div className="mt-3 overflow-hidden rounded-md bg-black">
              {firstAttachment ? (
                <video
                  src={firstAttachment.previewUrl}
                  controls
                  className="aspect-video w-full bg-black"
                />
              ) : (
                <div className="flex aspect-video items-center justify-center text-sm text-white/55">
                  No video attached
                </div>
              )}
            </div>
          </div>

          <div className="rounded-md border border-black/10 p-3">
            <p className="text-sm font-medium">Transcript</p>
            <p className="mt-3 text-sm leading-6 text-black/60">
              Welcome to this tutorial. First, we identify the key action. Next,
              we explain each step clearly. Finally, we summarize the workflow so
              viewers can repeat it.
            </p>
          </div>

          <div className="rounded-md border border-black/10 p-3">
            <p className="text-sm font-medium">Subtitles</p>
            <pre className="mt-3 overflow-x-auto rounded bg-black/[0.03] p-3 text-xs leading-5 text-black/65">
{`1
00:00:00,000 --> 00:00:03,200
Identify the key action.

2
00:00:03,200 --> 00:00:07,400
Follow each step in order.`}
            </pre>
          </div>

          <div className="rounded-md border border-black/10 p-3">
            <p className="text-sm font-medium">Document</p>
            <ol className="mt-3 list-decimal space-y-2 pl-4 text-sm leading-6 text-black/60">
              <li>Overview: {plan.objective}</li>
              <li>Steps: analyze, subtitle, render, publish.</li>
              <li>Output language: {plan.targetLanguageLabel}.</li>
            </ol>
          </div>

          <div
            id="mock-webpage-preview"
            className="rounded-md border border-black/10 p-3 lg:col-span-2"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">Webpage</p>
                <p className="mt-1 text-sm text-black/50">
                  A mock tutorial page with video, transcript, and steps.
                </p>
              </div>
              <a
                href="#mock-webpage-preview"
                className="rounded-md border border-black/15 px-3 py-2 text-sm font-medium transition hover:border-black"
              >
                Open webpage preview
              </a>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function Composer({
  prompt,
  targetLanguage,
  attachmentCount,
  totalSize,
  phase,
  onPromptChange,
  onTargetLanguageChange,
  onChooseVideos,
  onSubmit,
}: {
  prompt: string;
  targetLanguage: string;
  attachmentCount: number;
  totalSize: number;
  phase: ChatPhase;
  onPromptChange(value: string): void;
  onTargetLanguageChange(value: string): void;
  onChooseVideos(event: ChangeEvent<HTMLInputElement>): void;
  onSubmit(event: FormEvent<HTMLFormElement>): void;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const isBusy = phase === "processing";
  const isTaskLocked =
    phase === "planned" ||
    phase === "editing" ||
    phase === "processing" ||
    phase === "complete";
  const canSubmit =
    !isBusy &&
    ((phase === "clarifying" && prompt.trim().length > 0) ||
      (phase === "idle" && attachmentCount > 0));
  const submitLabel =
    phase === "clarifying"
      ? "Answer"
      : phase === "processing"
        ? "Running"
        : phase === "complete"
          ? "Done"
          : "Send";

  return (
    <form
      onSubmit={onSubmit}
      className="shrink-0 border-t border-black/10 bg-white px-4 py-3 sm:px-6"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 rounded-md border border-black/15 bg-white p-3 shadow-lg shadow-black/[0.05]">
        <label htmlFor="prompt" className="sr-only">
          Prompt
        </label>
        <textarea
          id="prompt"
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
          rows={2}
          disabled={isTaskLocked}
          placeholder={
            phase === "clarifying"
              ? "Answer the question so Blooclip can shape the plan..."
              : "Tell Blooclip what you want these videos to become..."
          }
          className="max-h-40 min-h-12 w-full resize-none border-0 bg-transparent text-sm leading-6 text-black outline-none placeholder:text-black/35 disabled:text-black/45"
        />

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={UPLOAD_ACCEPT_ATTRIBUTE}
              onChange={onChooseVideos}
              disabled={isTaskLocked}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={isTaskLocked}
              className="h-9 rounded-md border border-black px-3 text-sm font-medium text-black transition hover:bg-black hover:text-white disabled:cursor-not-allowed disabled:border-black/15 disabled:text-black/35"
            >
              Attach videos
            </button>

            <label htmlFor="target-language" className="sr-only">
              Target language
            </label>
            <select
              id="target-language"
              value={targetLanguage}
              onChange={(event) => onTargetLanguageChange(event.target.value)}
              disabled={isTaskLocked}
              className="h-9 rounded-md border border-black/15 bg-white px-2 text-sm font-medium text-black disabled:text-black/35"
            >
              {TARGET_LANGUAGE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>

            {attachmentCount > 0 && (
              <p className="text-sm text-black/55">
                {attachmentCount} selected · {formatFileSize(totalSize)}
              </p>
            )}
          </div>

          <button
            type="submit"
            disabled={!canSubmit}
            className="h-9 rounded-md bg-black px-4 text-sm font-semibold text-white transition hover:bg-black/80 disabled:cursor-not-allowed disabled:bg-black/25"
          >
            {submitLabel}
          </button>
        </div>
      </div>
    </form>
  );
}

function ChatTaskWorkspace() {
  const [messages, setMessages] =
    useState<ConversationMessage[]>(INITIAL_MESSAGES);
  const [prompt, setPrompt] = useState("");
  const [targetLanguage, setTargetLanguage] = useState<string>(
    DEFAULT_TARGET_LANGUAGE
  );
  const [attachments, setAttachments] = useState<UploadAttachment[]>([]);
  const [rejectedItems, setRejectedItems] = useState<RejectedUploadItem[]>([]);
  const [phase, setPhase] = useState<ChatPhase>("idle");
  const [plan, setPlan] = useState<MockPlan | null>(null);
  const [editPlanText, setEditPlanText] = useState("");
  const [activeStepIndex, setActiveStepIndex] = useState(0);
  const attachmentUrlsRef = useRef<string[]>([]);
  const completionMessageAddedRef = useRef(false);

  const totalSize = useMemo(
    () => attachments.reduce((total, item) => total + item.size, 0),
    [attachments]
  );
  const firstAttachment = attachments[0] ?? null;

  const releaseAttachmentUrls = useCallback(() => {
    for (const url of attachmentUrlsRef.current) {
      URL.revokeObjectURL(url);
    }

    attachmentUrlsRef.current = [];
  }, []);

  useEffect(() => {
    return () => {
      releaseAttachmentUrls();
    };
  }, [releaseAttachmentUrls]);

  useEffect(() => {
    if (phase !== "processing" || !plan) {
      return;
    }

    if (activeStepIndex >= plan.steps.length) {
      if (!completionMessageAddedRef.current) {
        completionMessageAddedRef.current = true;
        setPhase("complete");
        setMessages((current) => [
          ...current,
          {
            id: getMessageId("assistant-complete"),
            role: "assistant",
            text:
              "The mock run is complete. I prepared the video, transcript, subtitles, document, and webpage artifacts below.",
          },
        ]);
      }

      return;
    }

    const timer = window.setTimeout(() => {
      setActiveStepIndex((current) => current + 1);
    }, 850);

    return () => {
      window.clearTimeout(timer);
    };
  }, [activeStepIndex, phase, plan]);

  function appendMessages(nextMessages: ConversationMessage[]) {
    setMessages((current) => [...current, ...nextMessages]);
  }

  function chooseVideos(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    const prepared = prepareClientUploadFiles(files);
    const nextAttachments = prepared.accepted.map((upload, index) => {
      const previewUrl = URL.createObjectURL(upload.file);

      return {
        ...upload,
        id: getUploadItemId(upload.file, index),
        previewUrl,
      };
    });
    const nextRejectedItems = prepared.rejected.map((item, index) => ({
      id: `rejected-${item.filename}-${index}`,
      filename: item.filename,
      error: item.error,
    }));

    releaseAttachmentUrls();
    attachmentUrlsRef.current = nextAttachments.map(
      (attachment) => attachment.previewUrl
    );

    setAttachments(nextAttachments);
    setRejectedItems(nextRejectedItems);
    event.target.value = "";
  }

  function draftPlan(objective: string) {
    const nextPlan = createMockPlan({
      objective,
      targetLanguage,
      attachments,
    });

    setPlan(nextPlan);
    setEditPlanText(nextPlan.objective);
    setPhase("planned");
    appendMessages([
      {
        id: getMessageId("assistant-plan"),
        role: "assistant",
        text:
          "I drafted a structured plan. Review it, edit it if needed, then approve it to start the mock processing timeline.",
      },
    ]);
  }

  function submitPrompt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (phase === "clarifying") {
      const answer = prompt.trim();

      if (!answer) {
        return;
      }

      setPrompt("");
      appendMessages([
        {
          id: getMessageId("user-clarification"),
          role: "user",
          text: answer,
        },
      ]);
      draftPlan(answer);
      return;
    }

    if (phase !== "idle" || attachments.length === 0) {
      return;
    }

    const userPrompt = prompt.trim();

    setPrompt("");
    appendMessages([
      {
        id: getMessageId("user-upload"),
        role: "user",
        text:
          userPrompt ||
          "I uploaded these videos and need help deciding the best tutorial plan.",
        attachments,
      },
    ]);

    if (!userPrompt) {
      setPhase("clarifying");
      appendMessages([
        {
          id: getMessageId("assistant-question"),
          role: "assistant",
          text:
            "What should the finished tutorial teach, and who is it for? A short answer is enough.",
        },
      ]);
      return;
    }

    draftPlan(userPrompt);
  }

  function startEditPlan() {
    if (!plan) {
      return;
    }

    setEditPlanText(plan.objective);
    setPhase("editing");
  }

  function savePlanEdit() {
    if (!plan) {
      return;
    }

    const nextObjective = editPlanText.trim() || plan.objective;

    setPlan({
      ...plan,
      objective: nextObjective,
    });
    setEditPlanText(nextObjective);
    setPhase("planned");
    appendMessages([
      {
        id: getMessageId("assistant-edit"),
        role: "assistant",
        text: "Plan updated. Approve it when it matches the task.",
      },
    ]);
  }

  function approvePlan() {
    if (!plan) {
      return;
    }

    completionMessageAddedRef.current = false;
    setPhase("processing");
    setActiveStepIndex(0);
    appendMessages([
      {
        id: getMessageId("assistant-approved"),
        role: "assistant",
        text: "Plan approved. I am starting the mock processing timeline now.",
      },
    ]);
  }

  return (
    <section className="flex min-h-screen flex-col bg-white text-black lg:h-screen lg:min-h-0">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-black/10 px-4 sm:px-6">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-md border border-black bg-black text-sm font-semibold text-white">
            B
          </div>
          <div>
            <p className="text-sm font-semibold tracking-tight">Blooclip</p>
            <p className="text-xs text-black/45">AI-native mock workflow</p>
          </div>
        </div>
        <p className="text-xs font-medium text-black/45">No backend run</p>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6 sm:py-8">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
          {messages.map((message) => (
            <ConversationMessageRow key={message.id} message={message} />
          ))}

          {rejectedItems.length > 0 && (
            <div className="ml-0 max-w-[760px] sm:ml-10">
              <RejectedFiles rejectedItems={rejectedItems} />
            </div>
          )}

          {attachments.length > 0 && phase === "idle" && (
            <div className="ml-0 max-w-[760px] rounded-md border border-black/10 bg-white p-4 shadow-sm shadow-black/[0.02] sm:ml-10">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold">Ready to send</p>
                  <p className="mt-1 text-sm text-black/50">
                    {attachments.length} {pluralizeVideo(attachments.length)} ·{" "}
                    {formatFileSize(totalSize)}
                  </p>
                </div>
                <span className="rounded border border-black/10 px-2 py-1 text-xs font-medium text-black/55">
                  Local files
                </span>
              </div>
              <div className="mt-3 grid gap-2">
                {attachments.map((attachment) => (
                  <AttachmentCard key={attachment.id} attachment={attachment} />
                ))}
              </div>
            </div>
          )}

          {plan && (
            <PlanCard
              plan={plan}
              phase={phase}
              editPlanText={editPlanText}
              onEditPlanTextChange={setEditPlanText}
              onStartEdit={startEditPlan}
              onSaveEdit={savePlanEdit}
              onApprove={approvePlan}
            />
          )}

          {plan && (phase === "processing" || phase === "complete") && (
            <TimelineCard
              steps={plan.steps}
              activeStepIndex={activeStepIndex}
            />
          )}

          {plan && phase === "complete" && (
            <ArtifactCard plan={plan} firstAttachment={firstAttachment} />
          )}
        </div>
      </div>

      <Composer
        prompt={prompt}
        targetLanguage={targetLanguage}
        attachmentCount={attachments.length}
        totalSize={totalSize}
        phase={phase}
        onPromptChange={setPrompt}
        onTargetLanguageChange={setTargetLanguage}
        onChooseVideos={chooseVideos}
        onSubmit={submitPrompt}
      />
    </section>
  );
}

export function UploadWorkspace() {
  return (
    <main className="min-h-screen bg-white text-black lg:h-screen lg:overflow-hidden">
      <ChatTaskWorkspace />
    </main>
  );
}
