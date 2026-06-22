import { retry, task } from "@trigger.dev/sdk/v3";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  FileState,
  GoogleGenAI,
  type File as GeminiFile,
  type Part,
} from "@google/genai";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

import {
  INSTRUCTION_DOCUMENT_SCHEMA,
  InstructionDocumentValidationError,
  validateInstructionDocument,
  type InstructionDocument,
  type InstructionDocumentArtifact,
  type InstructionDocumentArtifactStep,
} from "../lib/instruction-document";
import { renderInstructionDocumentPdf } from "../lib/instruction-document-pdf";
import { getOpenAiErrorMessage } from "../lib/openai-error";
import {
  buildInstructionOverlayRenderPlan,
  getSelectedSegmentReferences,
  INSTRUCTION_OVERLAY_PLAN_SCHEMA,
  InstructionOverlayPlanValidationError,
  validateInstructionOverlayPlan,
  type InstructionOverlayPlan,
  type InstructionOverlayRenderPlan,
} from "../lib/instruction-overlay-plan";
import { DEFAULT_TARGET_LANGUAGE } from "../lib/languages";
import { r2, R2_BUCKET_NAME } from "../lib/r2";
import {
  buildSubtitleCues,
  SubtitleCueGenerationError,
} from "../lib/subtitle-cues";
import { supabaseAdmin } from "../lib/supabase-admin";
import { getTargetLanguageCode } from "../lib/target-language";
import {
  VIDEO_EVENT_ANALYSIS_SCHEMA,
  VideoEventAnalysisValidationError,
  validateVideoEventAnalysis,
  type VideoEventAnalysisArtifact,
} from "../lib/video-event-analysis";
import { buildVoiceoverAlignmentFromTranscript } from "../lib/voiceover-alignment";
import {
  buildAssInstructionOverlayFile,
  buildAssSubtitleFile,
  buildClipScalePadFilters,
  readRenderDimensionsFromFfprobe,
  type InstructionOverlayCue,
  type RenderDimensions,
  type SubtitleCue,
} from "../lib/video-rendering";

type ProcessVideoPayload = {
  videoId: string;
  originalR2Key: string;
};

type VideoRow = {
  id: string;
  original_r2_key: string | null;
  original_content_type: string | null;
  prompt: string | null;
  target_language: string | null;
};

type WorkerStage =
  | "queued"
  | "downloading_source"
  | "extracting_audio"
  | "transcribing_audio"
  | "transcript_ready"
  | "analyzing_video_events"
  | "video_event_analysis_ready"
  | "sampling_frames"
  | "analyzing_visuals"
  | "visual_analysis_ready"
  | "planning_segments"
  | "edit_plan_ready"
  | "writing_instruction_document"
  | "instruction_document_ready"
  | "writing_script"
  | "generating_voiceover"
  | "building_subtitles"
  | "voiceover_subtitles_ready"
  | "cutting_clips"
  | "rendering_final"
  | "uploading_final"
  | "completed";

type AssemblyAiSubmitResponse = {
  id?: unknown;
};

type AssemblyAiTranscriptResponse = {
  id?: unknown;
  status?: unknown;
  error?: unknown;
  text?: unknown;
  words?: unknown;
  utterances?: unknown;
  language_code?: unknown;
  language_confidence?: unknown;
};

type SampledFrame = {
  index: number;
  timestampSeconds: number;
  filePath: string;
  r2Key: string;
  sizeBytes: number;
};

type GlossaryRule = {
  term: string;
  caseSensitive: boolean;
  notes: string | null;
  mode: "do_not_translate" | "use_override";
  targetLanguage: string;
  resolvedText: string;
};

type PronunciationDictionaryLocator = {
  pronunciation_dictionary_id: string;
  version_id: string;
};

type BrandLanguageContext = {
  source: "none" | "brand_kit";
  version: string | null;
  targetLanguage: string;
  glossaryRules: GlossaryRule[];
  pronunciationDictionaryLocators: PronunciationDictionaryLocator[];
};

type OpenAiResponsesResponse = {
  id?: unknown;
  status?: unknown;
  error?: unknown;
  incomplete_details?: unknown;
  model?: unknown;
  output?: unknown;
  output_text?: unknown;
  usage?: unknown;
};

type OpenAiReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";
type OpenAiImageDetail = "low" | "high" | "auto";
type VideoAnalysisProvider = "twelvelabs" | "gemini" | "openai";
type VideoStyle = "instruction_overlay" | "voiceover_subtitles";
type FinalRenderer = "remotion" | "ffmpeg";

const STAGE_PROGRESS: Record<WorkerStage, number> = {
  queued: 5,
  downloading_source: 8,
  extracting_audio: 12,
  transcribing_audio: 24,
  transcript_ready: 24,
  analyzing_video_events: 30,
  video_event_analysis_ready: 32,
  sampling_frames: 36,
  analyzing_visuals: 50,
  visual_analysis_ready: 50,
  planning_segments: 60,
  edit_plan_ready: 60,
  writing_instruction_document: 66,
  instruction_document_ready: 68,
  writing_script: 72,
  generating_voiceover: 80,
  building_subtitles: 86,
  voiceover_subtitles_ready: 88,
  cutting_clips: 91,
  rendering_final: 95,
  uploading_final: 98,
  completed: 100,
};

const ASSEMBLYAI_PROVIDER = "assemblyai";
const ASSEMBLYAI_DEFAULT_BASE_URL = "https://api.assemblyai.com";
const ASSEMBLYAI_TRANSCRIPT_TIMEOUT_MS = 25 * 60 * 1000;
const ASSEMBLYAI_POLL_INTERVAL_MS = 3000;
const OPENAI_PROVIDER = "openai";
const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";
const OPENAI_DEFAULT_MODEL = "gpt-5.5";
const OPENAI_DEFAULT_REASONING_EFFORT: OpenAiReasoningEffort = "high";
const OPENAI_DEFAULT_IMAGE_DETAIL: OpenAiImageDetail = "high";
const OPENAI_TTS_DEFAULT_MODEL = "gpt-4o-mini-tts";
const OPENAI_TTS_DEFAULT_VOICE = "cedar";
const OPENAI_TTS_OUTPUT_FORMAT = "mp3";
const OPENAI_FETCH_TIMEOUT_MS = 10 * 60 * 1000;
const OPENAI_FETCH_RETRY_OPTIONS = {
  byStatus: {
    "429,408,409,5xx": {
      strategy: "backoff",
      maxAttempts: 3,
      factor: 2,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 30_000,
      randomize: true,
    },
  },
  connectionError: {
    maxAttempts: 3,
    factor: 2,
    minTimeoutInMs: 1000,
    maxTimeoutInMs: 30_000,
    randomize: true,
  },
  timeout: {
    maxAttempts: 3,
    factor: 2,
    minTimeoutInMs: 1000,
    maxTimeoutInMs: 30_000,
    randomize: true,
  },
} as const;
const TWELVELABS_PROVIDER = "twelvelabs";
const TWELVELABS_DEFAULT_BASE_URL = "https://api.twelvelabs.io/v1.3";
const TWELVELABS_DEFAULT_MODEL = "pegasus1.5";
const TWELVELABS_ANALYSIS_TIMEOUT_MS = 25 * 60 * 1000;
const TWELVELABS_POLL_INTERVAL_MS = 5000;
const TWELVELABS_SIGNED_URL_EXPIRES_SECONDS = 2 * 60 * 60;
const GEMINI_PROVIDER = "gemini";
const GEMINI_DEFAULT_MODEL = "gemini-3.5-flash";
const GEMINI_FILE_PROCESSING_TIMEOUT_MS = 10 * 60 * 1000;
const GEMINI_FILE_POLL_INTERVAL_MS = 3000;
const DEFAULT_FRAME_SAMPLE_INTERVAL_SECONDS = 3;
const DEFAULT_MAX_VISUAL_FRAMES = 30;
const OPENAI_VISUAL_ANALYSIS_DEFAULT_MAX_OUTPUT_TOKENS = 20000;
const OPENAI_EDIT_PLAN_DEFAULT_MAX_OUTPUT_TOKENS = 20000;
const OPENAI_OVERLAY_PLAN_DEFAULT_MAX_OUTPUT_TOKENS = 10000;
const OPENAI_INSTRUCTION_DOCUMENT_DEFAULT_MAX_OUTPUT_TOKENS = 12000;
const OPENAI_VOICEOVER_SCRIPT_DEFAULT_MAX_OUTPUT_TOKENS = 6000;
const GEMINI_VIDEO_EVENT_ANALYSIS_MAX_OUTPUT_TOKENS = 8000;
const MAX_TRANSCRIPT_CONTEXT_CHARS = 6000;
const MAX_EDIT_PLAN_UTTERANCES = 80;
const MAX_EDIT_PLAN_WORDS = 300;
const MIN_EDIT_SEGMENT_DURATION_SECONDS = 0.25;
const FINAL_RENDER_CRF = "23";
const FINAL_RENDER_PRESET = "veryfast";
const DEFAULT_VIDEO_STYLE: VideoStyle = "instruction_overlay";
const DEFAULT_RENDERER: FinalRenderer = "ffmpeg";
const DEFAULT_OUTPUT_VIDEO_BITRATE = "8M";
const EXPERIMENTAL_REMOTION_RENDERER_ENV = "EXPERIMENTAL_REMOTION_RENDERER";
const REMOTION_COMPOSITION_ID = "InstructionVideo";
const REMOTION_FPS = 30;
const MAX_INSTRUCTION_DOCUMENT_STEPS = 12;
const INSTRUCTION_FRAME_WIDTH = 1280;
const SUBTITLE_FONTS_DIR = path.join(process.cwd(), "assets", "fonts");
const VISUAL_TIMELINE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "frames", "candidateMoments", "warnings"],
  properties: {
    summary: {
      type: "string",
      description: "Concise summary of the visual story visible in the frames.",
    },
    frames: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "index",
          "timestampSeconds",
          "description",
          "visibleText",
          "actions",
          "setting",
          "shotType",
          "quality",
          "promptRelevance",
          "confidence",
        ],
        properties: {
          index: {
            type: "integer",
            description: "Frame index provided by the worker.",
          },
          timestampSeconds: {
            type: "number",
            description: "Frame timestamp in seconds provided by the worker.",
          },
          description: {
            type: "string",
            description: "What is visually happening in the frame.",
          },
          visibleText: {
            type: "array",
            items: { type: "string" },
            description: "Any readable text visible in the frame.",
          },
          actions: {
            type: "array",
            items: { type: "string" },
            description: "Visible actions or events in the frame.",
          },
          setting: {
            type: "string",
            description: "Location, environment, or scene type.",
          },
          shotType: {
            type: "string",
            description: "Camera framing or visual composition.",
          },
          quality: {
            type: "object",
            additionalProperties: false,
            required: ["usable", "issues"],
            properties: {
              usable: {
                type: "boolean",
                description: "Whether this frame appears usable for editing.",
              },
              issues: {
                type: "array",
                items: { type: "string" },
                description: "Blur, darkness, obstruction, or other issues.",
              },
            },
          },
          promptRelevance: {
            type: "string",
            description: "How this frame may relate to the user prompt.",
          },
          confidence: {
            type: "number",
            description: "Confidence from 0 to 1.",
          },
        },
      },
    },
    candidateMoments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "startSeconds",
          "endSeconds",
          "description",
          "reason",
          "confidence",
        ],
        properties: {
          startSeconds: {
            type: "number",
            description: "Rough visual moment start time in seconds.",
          },
          endSeconds: {
            type: "number",
            description: "Rough visual moment end time in seconds.",
          },
          description: {
            type: "string",
            description: "What the candidate moment visually contains.",
          },
          reason: {
            type: "string",
            description: "Why this moment may be useful later.",
          },
          confidence: {
            type: "number",
            description: "Confidence from 0 to 1.",
          },
        },
      },
    },
    warnings: {
      type: "array",
      items: { type: "string" },
      description: "Any limitations caused by sparse frame sampling.",
    },
  },
} as const;
const EDIT_PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "tutorialGoal",
    "tutorialSteps",
    "segments",
    "omittedContent",
    "warnings",
  ],
  properties: {
    tutorialGoal: {
      type: "string",
      description:
        "The inferred tutorial goal that the selected segments must preserve.",
    },
    tutorialSteps: {
      type: "array",
      minItems: 1,
      description:
        "The logical tutorial step sequence inferred before selecting clips. Must contain at least one step.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["stepIndex", "title", "objective", "evidence"],
        properties: {
          stepIndex: {
            type: "integer",
            minimum: 1,
            description: "One-based tutorial step index.",
          },
          title: {
            type: "string",
            description: "Short title for this tutorial step.",
          },
          objective: {
            type: "string",
            description: "What the viewer should understand from this step.",
          },
          evidence: {
            type: "string",
            description:
              "Transcript or visual evidence used to identify this step.",
          },
        },
      },
    },
    segments: {
      type: "array",
      minItems: 1,
      description:
        "Selected source ranges for the final tutorial edit. Must contain at least one segment.",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "segmentIndex",
          "tutorialStepIndex",
          "sourceStart",
          "sourceEnd",
          "reason",
          "visualEvidenceFrameIndexes",
          "transcriptEvidence",
          "confidence",
        ],
        properties: {
          segmentIndex: {
            type: "integer",
            minimum: 1,
            description: "One-based selected segment index.",
          },
          tutorialStepIndex: {
            type: "integer",
            minimum: 1,
            description:
              "The tutorial step index this selected segment supports.",
          },
          sourceStart: {
            type: "number",
            description:
              "Start time in source video seconds. Required for FFmpeg rendering.",
          },
          sourceEnd: {
            type: "number",
            description:
              "End time in source video seconds. Required for FFmpeg rendering.",
          },
          reason: {
            type: "string",
            description:
              "Why this exact source range is needed for tutorial clarity.",
          },
          visualEvidenceFrameIndexes: {
            type: "array",
            items: { type: "integer" },
            description:
              "Frame indexes from the visual timeline that support this segment.",
          },
          transcriptEvidence: {
            type: "string",
            description:
              "Transcript evidence or timing cues that support this segment.",
          },
          confidence: {
            type: "number",
            minimum: 0,
            maximum: 1,
            description: "Confidence from 0 to 1.",
          },
        },
      },
    },
    omittedContent: {
      type: "array",
      description:
        "Chronological source ranges intentionally omitted from the tutorial edit.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["sourceStart", "sourceEnd", "reason"],
        properties: {
          sourceStart: {
            type: "number",
            description: "Start time in source video seconds.",
          },
          sourceEnd: {
            type: "number",
            description: "End time in source video seconds.",
          },
          reason: {
            type: "string",
            description:
              "Why this range can be removed without breaking viewer understanding.",
          },
        },
      },
    },
    warnings: {
      type: "array",
      items: { type: "string" },
      description:
        "Planning limitations, including weak tutorial evidence or sparse frame sampling.",
    },
  },
} as const;
const VOICEOVER_SCRIPT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "script",
    "targetLanguage",
    "selectedDurationSeconds",
    "estimatedSpeakingSeconds",
    "warnings",
  ],
  properties: {
    script: {
      type: "string",
      description:
        "Plain narration text only. No markdown, timestamps, labels, stage directions, or phonetic replacements.",
    },
    targetLanguage: {
      type: "string",
      description: "The target language requested by the worker.",
    },
    selectedDurationSeconds: {
      type: "number",
      exclusiveMinimum: 0,
      description: "Total selected visual segment duration in seconds.",
    },
    estimatedSpeakingSeconds: {
      type: "number",
      exclusiveMinimum: 0,
      description: "Estimated duration of the generated voiceover.",
    },
    warnings: {
      type: "array",
      items: { type: "string" },
      description: "Script limitations or tradeoffs. Can be empty.",
    },
  },
} as const;

class WorkerError extends Error {
  code: string;
  provider: string | null;
  providerRequestId: string | null;
  retryable: boolean;

  constructor(
    message: string,
    options: {
      code: string;
      provider?: string | null;
      providerRequestId?: string | null;
      retryable?: boolean;
    }
  ) {
    super(message);
    this.name = "WorkerError";
    this.code = options.code;
    this.provider = options.provider ?? null;
    this.providerRequestId = options.providerRequestId ?? null;
    this.retryable = options.retryable ?? false;
  }
}

async function updateVideo(videoId: string, values: Record<string, unknown>) {
  const { error } = await supabaseAdmin
    .from("videos")
    .update({ ...values, updated_at: new Date().toISOString() })
    .eq("id", videoId);

  if (error) {
    throw new Error(`Failed to update video status: ${error.message}`);
  }
}

async function loadVideo(videoId: string) {
  const { data, error } = await supabaseAdmin
    .from("videos")
    .select("id,original_r2_key,original_content_type,prompt,target_language")
    .eq("id", videoId)
    .single();

  if (error) {
    throw new WorkerError(`Failed to load video row: ${error.message}`, {
      code:
        error.code === "PGRST116" ? "video_not_found" : "supabase_load_failed",
      provider: "supabase",
      retryable: error.code !== "PGRST116",
    });
  }

  return data as VideoRow;
}

async function updateStage(videoId: string, stage: WorkerStage) {
  await updateVideo(videoId, {
    status: "processing",
    current_stage: stage,
    progress: STAGE_PROGRESS[stage],
    error_message: null,
    error_code: null,
    error_provider: null,
    provider_request_id: null,
    retryable: null,
  });
}

async function downloadFromR2(key: string, filePath: string) {
  const result = await r2.send(
    new GetObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
    })
  );

  if (!result.Body) {
    throw new Error("R2 object has no body");
  }

  await pipeline(
    result.Body as NodeJS.ReadableStream,
    createWriteStream(filePath)
  );
}

async function uploadFileToR2(
  key: string,
  filePath: string,
  contentType: string
) {
  await r2.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
      Body: createReadStream(filePath),
      ContentType: contentType,
    })
  );
}

async function uploadJsonToR2(key: string, value: unknown) {
  await r2.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
      Body: JSON.stringify(value, null, 2),
      ContentType: "application/json",
    })
  );
}

async function createSignedR2ReadUrl(key: string, expiresInSeconds: number) {
  return getSignedUrl(
    r2,
    new GetObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
    }),
    { expiresIn: expiresInSeconds }
  );
}

function runFfmpeg(args: string[], options?: { cwd?: string }) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", args, {
      stdio: "inherit",
      cwd: options?.cwd,
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg failed with exit code ${code}`));
      }
    });
  });
}

function runCommand(command: string, args: string[]) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("exit", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");

      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new Error(
            `${command} failed with exit code ${code}${
              stderr.trim() ? `: ${stderr.trim()}` : ""
            }`
          )
        );
      }
    });
  });
}

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/+$/, "");
}

function getOptionalStringEnv(name: string) {
  const value = process.env[name];

  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getPositiveNumberEnv(name: string, fallback: number) {
  const rawValue = process.env[name];

  if (!rawValue) {
    return fallback;
  }

  const value = Number(rawValue);

  if (!Number.isFinite(value) || value <= 0) {
    throw new WorkerError(`${name} must be a positive number`, {
      code: "worker_config_invalid",
      retryable: false,
    });
  }

  return value;
}

function getPositiveIntegerEnv(name: string, fallback: number) {
  const value = getPositiveNumberEnv(name, fallback);

  if (!Number.isInteger(value)) {
    throw new WorkerError(`${name} must be a positive integer`, {
      code: "worker_config_invalid",
      retryable: false,
    });
  }

  return value;
}

function getBooleanEnv(name: string, fallback: boolean) {
  const rawValue = process.env[name];

  if (!rawValue) {
    return fallback;
  }

  const normalized = rawValue.trim().toLowerCase();

  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  throw new WorkerError(`${name} must be true or false`, {
    code: "worker_config_invalid",
    retryable: false,
  });
}

function getEnumEnv<T extends string>(
  name: string,
  allowedValues: readonly T[],
  fallback: T
): T {
  const rawValue = process.env[name];

  if (!rawValue) {
    return fallback;
  }

  const normalized = rawValue.trim().toLowerCase();

  if (allowedValues.includes(normalized as T)) {
    return normalized as T;
  }

  throw new WorkerError(
    `${name} must be one of: ${allowedValues.join(", ")}`,
    {
      code: "worker_config_invalid",
      retryable: false,
    }
  );
}

function getVideoStyle() {
  return getEnumEnv<VideoStyle>(
    "VIDEO_STYLE",
    ["instruction_overlay", "voiceover_subtitles"],
    DEFAULT_VIDEO_STYLE
  );
}

function getRenderer() {
  return getEnumEnv<FinalRenderer>(
    "RENDERER",
    ["remotion", "ffmpeg"],
    DEFAULT_RENDERER
  );
}

function getExperimentalRemotionRendererEnabled() {
  return getBooleanEnv(EXPERIMENTAL_REMOTION_RENDERER_ENV, false);
}

function getOutputVideoBitrate() {
  return getOptionalStringEnv("OUTPUT_VIDEO_BITRATE") ?? DEFAULT_OUTPUT_VIDEO_BITRATE;
}

function getOpenAiMaxOutputTokens() {
  return {
    visualAnalysis: getPositiveIntegerEnv(
      "OPENAI_VISUAL_ANALYSIS_MAX_OUTPUT_TOKENS",
      OPENAI_VISUAL_ANALYSIS_DEFAULT_MAX_OUTPUT_TOKENS
    ),
    editPlan: getPositiveIntegerEnv(
      "OPENAI_EDIT_PLAN_MAX_OUTPUT_TOKENS",
      OPENAI_EDIT_PLAN_DEFAULT_MAX_OUTPUT_TOKENS
    ),
    overlayPlan: getPositiveIntegerEnv(
      "OPENAI_OVERLAY_PLAN_MAX_OUTPUT_TOKENS",
      OPENAI_OVERLAY_PLAN_DEFAULT_MAX_OUTPUT_TOKENS
    ),
    instructionDocument: getPositiveIntegerEnv(
      "OPENAI_INSTRUCTION_DOCUMENT_MAX_OUTPUT_TOKENS",
      OPENAI_INSTRUCTION_DOCUMENT_DEFAULT_MAX_OUTPUT_TOKENS
    ),
    voiceoverScript: getPositiveIntegerEnv(
      "OPENAI_VOICEOVER_SCRIPT_MAX_OUTPUT_TOKENS",
      OPENAI_VOICEOVER_SCRIPT_DEFAULT_MAX_OUTPUT_TOKENS
    ),
  };
}

function getAssemblyAiConfig() {
  const apiKey = process.env.ASSEMBLYAI_API_KEY;

  if (!apiKey) {
    throw new WorkerError(
      "Missing AssemblyAI API key. Set ASSEMBLYAI_API_KEY.",
      {
        code: "assemblyai_api_key_missing",
        provider: ASSEMBLYAI_PROVIDER,
        retryable: false,
      }
    );
  }

  return {
    apiKey,
    baseUrl: normalizeBaseUrl(
      process.env.ASSEMBLYAI_BASE_URL ?? ASSEMBLYAI_DEFAULT_BASE_URL
    ),
  };
}

function getOpenAiConfig() {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new WorkerError("Missing OpenAI API key. Set OPENAI_API_KEY.", {
      code: "openai_api_key_missing",
      provider: OPENAI_PROVIDER,
      retryable: false,
    });
  }

  return {
    apiKey,
    baseUrl: normalizeBaseUrl(
      process.env.OPENAI_BASE_URL ?? OPENAI_DEFAULT_BASE_URL
    ),
    model: getOptionalStringEnv("OPENAI_WORKER_MODEL") ?? OPENAI_DEFAULT_MODEL,
    reasoningEffort: getEnumEnv<OpenAiReasoningEffort>(
      "OPENAI_REASONING_EFFORT",
      ["none", "low", "medium", "high", "xhigh"],
      OPENAI_DEFAULT_REASONING_EFFORT
    ),
    imageDetail: getEnumEnv<OpenAiImageDetail>(
      "OPENAI_IMAGE_DETAIL",
      ["low", "high", "auto"],
      OPENAI_DEFAULT_IMAGE_DETAIL
    ),
    maxOutputTokens: getOpenAiMaxOutputTokens(),
  };
}

function getTwelveLabsConfig() {
  const apiKey = process.env.TWELVELABS_API_KEY;

  if (!apiKey) {
    throw new WorkerError(
      "Missing TwelveLabs API key. Set TWELVELABS_API_KEY.",
      {
        code: "twelvelabs_api_key_missing",
        provider: TWELVELABS_PROVIDER,
        retryable: false,
      }
    );
  }

  return {
    apiKey,
    baseUrl: normalizeBaseUrl(
      process.env.TWELVELABS_BASE_URL ?? TWELVELABS_DEFAULT_BASE_URL
    ),
    model: process.env.TWELVELABS_ANALYZE_MODEL ?? TWELVELABS_DEFAULT_MODEL,
  };
}

function getGeminiConfig(options?: {
  enabledOverride?: boolean;
  requiredOverride?: boolean;
}) {
  const apiKey = process.env.GEMINI_API_KEY;
  const enabled =
    options?.enabledOverride ??
    getBooleanEnv("GEMINI_VIDEO_EVENT_ANALYSIS_ENABLED", false);
  const required =
    options?.requiredOverride ??
    getBooleanEnv("GEMINI_VIDEO_EVENT_ANALYSIS_REQUIRED", false);

  if (required && !enabled) {
    throw new WorkerError(
      "Gemini video event analysis is required but disabled. Set GEMINI_VIDEO_EVENT_ANALYSIS_ENABLED=true.",
      {
        code: "gemini_video_event_analysis_disabled",
        provider: GEMINI_PROVIDER,
        retryable: false,
      }
    );
  }

  if ((enabled || required) && !apiKey) {
    throw new WorkerError("Missing Gemini API key. Set GEMINI_API_KEY.", {
      code: "gemini_api_key_missing",
      provider: GEMINI_PROVIDER,
      retryable: false,
    });
  }

  return {
    enabled,
    required,
    apiKey: apiKey ?? null,
    model: process.env.GEMINI_VIDEO_MODEL ?? GEMINI_DEFAULT_MODEL,
  };
}

function getVideoAnalysisConfig() {
  const rawProvider = process.env.VIDEO_ANALYSIS_PROVIDER;

  if (rawProvider) {
    const provider = getEnumEnv<VideoAnalysisProvider>(
      "VIDEO_ANALYSIS_PROVIDER",
      ["twelvelabs", "gemini", "openai"],
      "openai"
    );

    if (provider === "twelvelabs") {
      const twelveLabs = getTwelveLabsConfig();

      return {
        provider,
        required: true,
        twelveLabs,
        gemini: getGeminiConfig(),
      };
    }

    if (provider === "gemini") {
      return {
        provider,
        required: true,
        twelveLabs: null,
        gemini: getGeminiConfig({
          enabledOverride: true,
          requiredOverride: true,
        }),
      };
    }

    return {
      provider,
      required: false,
      twelveLabs: null,
      gemini: getGeminiConfig(),
    };
  }

  const gemini = getGeminiConfig();

  return {
    provider: gemini.enabled ? ("gemini" as const) : ("openai" as const),
    required: gemini.required,
    twelveLabs: null,
    gemini,
  };
}

function getGeminiVideoContentType(contentType: string | null) {
  const normalized = contentType?.split(";")[0]?.trim().toLowerCase();

  if (
    normalized === "video/mp4" ||
    normalized === "video/webm" ||
    normalized === "video/quicktime"
  ) {
    return normalized;
  }

  throw new WorkerError(
    `Unsupported or missing source video content type for Gemini: ${
      contentType ?? "unknown"
    }`,
    {
      code: "gemini_video_content_type_unsupported",
      provider: GEMINI_PROVIDER,
      retryable: false,
    }
  );
}

function getOpenAiTtsConfig() {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new WorkerError("Missing OpenAI API key. Set OPENAI_API_KEY.", {
      code: "openai_api_key_missing",
      provider: OPENAI_PROVIDER,
      retryable: false,
    });
  }

  return {
    apiKey,
    baseUrl: normalizeBaseUrl(
      process.env.OPENAI_BASE_URL ?? OPENAI_DEFAULT_BASE_URL
    ),
    model: getOptionalStringEnv("OPENAI_TTS_MODEL") ?? OPENAI_TTS_DEFAULT_MODEL,
    voice: getOptionalStringEnv("OPENAI_TTS_VOICE") ?? OPENAI_TTS_DEFAULT_VOICE,
    instructions: getOptionalStringEnv("OPENAI_TTS_INSTRUCTIONS"),
    responseFormat: OPENAI_TTS_OUTPUT_FORMAT,
  };
}

function getFrameSamplingConfig() {
  return {
    intervalSeconds: getPositiveNumberEnv(
      "VISUAL_FRAME_SAMPLE_INTERVAL_SECONDS",
      DEFAULT_FRAME_SAMPLE_INTERVAL_SECONDS
    ),
    maxFrames: getPositiveIntegerEnv(
      "VISUAL_FRAME_SAMPLE_MAX_FRAMES",
      DEFAULT_MAX_VISUAL_FRAMES
    ),
  };
}

async function readJsonResponse(response: Response) {
  const text = await response.text();

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function fetchOpenAi(
  input: string,
  init: RequestInit,
  options: {
    code: string;
    failureMessage: string;
  }
) {
  try {
    return await retry.fetch(input, {
      ...init,
      timeoutInMs: OPENAI_FETCH_TIMEOUT_MS,
      retry: OPENAI_FETCH_RETRY_OPTIONS,
    });
  } catch (error) {
    const detail =
      error instanceof Error && error.message !== "Fetch error"
        ? `: ${error.message}`
        : "";

    throw new WorkerError(`${options.failureMessage}${detail}`, {
      code: options.code,
      provider: OPENAI_PROVIDER,
      retryable: true,
    });
  }
}

function getProviderRequestId(response: Response) {
  return (
    response.headers.get("x-request-id") ??
    response.headers.get("request-id") ??
    response.headers.get("xi-request-id") ??
    null
  );
}

function getAssemblyAiErrorMessage(body: unknown, fallback: string) {
  if (body && typeof body === "object" && "error" in body) {
    const error = (body as { error?: unknown }).error;

    if (typeof error === "string" && error.trim()) {
      return error;
    }
  }

  if (typeof body === "string" && body.trim()) {
    return body;
  }

  return fallback;
}

async function uploadToAssemblyAi(filePath: string) {
  const { apiKey, baseUrl } = getAssemblyAiConfig();
  const response = await fetch(`${baseUrl}/v2/upload`, {
    method: "POST",
    headers: {
      authorization: apiKey,
    },
    body: createReadStream(filePath) as unknown as BodyInit,
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  const body = await readJsonResponse(response);

  if (!response.ok) {
    throw new WorkerError(
      getAssemblyAiErrorMessage(
        body,
        `AssemblyAI upload failed with HTTP ${response.status}`
      ),
      {
        code: "assemblyai_upload_failed",
        provider: ASSEMBLYAI_PROVIDER,
        providerRequestId: getProviderRequestId(response),
        retryable: response.status === 429 || response.status >= 500,
      }
    );
  }

  if (
    !body ||
    typeof body !== "object" ||
    typeof (body as { upload_url?: unknown }).upload_url !== "string"
  ) {
    throw new WorkerError("AssemblyAI upload response was invalid", {
      code: "assemblyai_upload_response_invalid",
      provider: ASSEMBLYAI_PROVIDER,
      providerRequestId: getProviderRequestId(response),
      retryable: true,
    });
  }

  return (body as { upload_url: string }).upload_url;
}

async function submitAssemblyAiTranscript(audioUrl: string) {
  const { apiKey, baseUrl } = getAssemblyAiConfig();
  const response = await fetch(`${baseUrl}/v2/transcript`, {
    method: "POST",
    headers: {
      authorization: apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      audio_url: audioUrl,
      speech_models: ["universal-3-pro", "universal-2"],
      language_detection: true,
      speaker_labels: true,
    }),
  });

  const body = (await readJsonResponse(response)) as AssemblyAiSubmitResponse;

  if (!response.ok) {
    throw new WorkerError(
      getAssemblyAiErrorMessage(
        body,
        `AssemblyAI transcript submit failed with HTTP ${response.status}`
      ),
      {
        code: "assemblyai_submit_failed",
        provider: ASSEMBLYAI_PROVIDER,
        providerRequestId: getProviderRequestId(response),
        retryable: response.status === 429 || response.status >= 500,
      }
    );
  }

  if (!body || typeof body.id !== "string") {
    throw new WorkerError("AssemblyAI transcript submit response was invalid", {
      code: "assemblyai_submit_response_invalid",
      provider: ASSEMBLYAI_PROVIDER,
      providerRequestId: getProviderRequestId(response),
      retryable: true,
    });
  }

  return body.id;
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollAssemblyAiTranscript(transcriptId: string) {
  const { apiKey, baseUrl } = getAssemblyAiConfig();
  const startedAt = Date.now();

  while (Date.now() - startedAt < ASSEMBLYAI_TRANSCRIPT_TIMEOUT_MS) {
    const response = await fetch(`${baseUrl}/v2/transcript/${transcriptId}`, {
      headers: {
        authorization: apiKey,
      },
    });

    const body =
      (await readJsonResponse(response)) as AssemblyAiTranscriptResponse | null;

    if (!response.ok) {
      throw new WorkerError(
        getAssemblyAiErrorMessage(
          body,
          `AssemblyAI transcript poll failed with HTTP ${response.status}`
        ),
        {
          code: "assemblyai_poll_failed",
          provider: ASSEMBLYAI_PROVIDER,
          providerRequestId: transcriptId,
          retryable: response.status === 429 || response.status >= 500,
        }
      );
    }

    if (body?.status === "completed") {
      return body;
    }

    if (body?.status === "error") {
      throw new WorkerError(
        getAssemblyAiErrorMessage(body, "AssemblyAI transcription failed"),
        {
          code: "assemblyai_transcription_failed",
          provider: ASSEMBLYAI_PROVIDER,
          providerRequestId: transcriptId,
          retryable: false,
        }
      );
    }

    await wait(ASSEMBLYAI_POLL_INTERVAL_MS);
  }

  throw new WorkerError("AssemblyAI transcription timed out", {
    code: "assemblyai_transcription_timeout",
    provider: ASSEMBLYAI_PROVIDER,
    providerRequestId: transcriptId,
    retryable: true,
  });
}

function roundSeconds(value: number) {
  return Math.round(value * 100) / 100;
}

async function getMediaDurationSeconds(
  filePath: string,
  errorCode: string,
  errorMessage: string
) {
  const { stdout } = await runCommand("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);
  const duration = Number(stdout.trim());

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new WorkerError(errorMessage, {
      code: errorCode,
      provider: "ffmpeg",
      retryable: false,
    });
  }

  return duration;
}

async function getVideoDurationSeconds(filePath: string) {
  return getMediaDurationSeconds(
    filePath,
    "ffprobe_duration_invalid",
    "Unable to read video duration with ffprobe"
  );
}

async function getSourceRenderDimensions(
  filePath: string
): Promise<RenderDimensions> {
  const { stdout } = await runCommand("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height,sample_aspect_ratio,display_aspect_ratio:stream_tags=rotate:stream_side_data=rotation",
    "-of",
    "json",
    filePath,
  ]);

  let parsedOutput: unknown;

  try {
    parsedOutput = JSON.parse(stdout) as unknown;
  } catch {
    throw new WorkerError("Unable to parse video dimensions with ffprobe", {
      code: "ffprobe_dimensions_invalid",
      provider: "ffmpeg",
      retryable: false,
    });
  }

  try {
    return readRenderDimensionsFromFfprobe(parsedOutput);
  } catch (error) {
    throw new WorkerError(
      error instanceof Error
        ? error.message
        : "Unable to read video dimensions with ffprobe",
      {
        code: "ffprobe_dimensions_invalid",
        provider: "ffmpeg",
        retryable: false,
      }
    );
  }
}

function buildFrameTimestamps(
  durationSeconds: number,
  intervalSeconds: number,
  maxFrames: number
) {
  const timestamps: number[] = [];

  for (
    let timestamp = 0;
    timestamp < durationSeconds && timestamps.length <= maxFrames;
    timestamp += intervalSeconds
  ) {
    timestamps.push(roundSeconds(timestamp));
  }

  if (timestamps.length === 0) {
    return [0];
  }

  if (timestamps.length <= maxFrames) {
    return timestamps;
  }

  if (maxFrames === 1) {
    return [0];
  }

  const lastTimestamp = Math.max(0, durationSeconds - 0.25);

  return Array.from({ length: maxFrames }, (_value, index) =>
    roundSeconds((lastTimestamp * index) / (maxFrames - 1))
  );
}

async function sampleFrames(
  videoId: string,
  inputPath: string,
  framesDir: string,
  knownDurationSeconds?: number
) {
  const { intervalSeconds, maxFrames } = getFrameSamplingConfig();
  const durationSeconds =
    knownDurationSeconds ?? (await getVideoDurationSeconds(inputPath));
  const timestamps = buildFrameTimestamps(
    durationSeconds,
    intervalSeconds,
    maxFrames
  );
  const sampledFrames: SampledFrame[] = [];

  await mkdir(framesDir, { recursive: true });

  for (const [index, timestampSeconds] of timestamps.entries()) {
    const frameNumber = String(index + 1).padStart(4, "0");
    const filename = `frame-${frameNumber}.jpg`;
    const filePath = path.join(framesDir, filename);
    const r2Key = `artifacts/${videoId}/frames/${filename}`;

    await runFfmpeg([
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      timestampSeconds.toFixed(3),
      "-i",
      inputPath,
      "-frames:v",
      "1",
      "-vf",
      "scale=640:-2",
      "-q:v",
      "3",
      filePath,
    ]);

    const fileStats = await stat(filePath);

    if (fileStats.size <= 0) {
      throw new WorkerError("FFmpeg produced an empty sampled frame", {
        code: "frame_sample_empty",
        provider: "ffmpeg",
        retryable: true,
      });
    }

    await uploadFileToR2(r2Key, filePath, "image/jpeg");
    sampledFrames.push({
      index: index + 1,
      timestampSeconds,
      filePath,
      r2Key,
      sizeBytes: fileStats.size,
    });
  }

  if (sampledFrames.length === 0) {
    throw new WorkerError("No frames were sampled from the source video", {
      code: "frame_sampling_empty",
      provider: "ffmpeg",
      retryable: false,
    });
  }

  return {
    durationSeconds: roundSeconds(durationSeconds),
    intervalSeconds,
    maxFrames,
    frames: sampledFrames,
  };
}

function extractOpenAiOutputText(body: OpenAiResponsesResponse) {
  if (typeof body.output_text === "string" && body.output_text.trim()) {
    return body.output_text;
  }

  const textParts: string[] = [];

  const collect = (value: unknown) => {
    if (!value) {
      return;
    }

    if (typeof value === "string") {
      const trimmed = value.trim();

      if (trimmed) {
        textParts.push(trimmed);
      }

      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        collect(item);
      }

      return;
    }

    if (typeof value !== "object") {
      return;
    }

    const record = value as Record<string, unknown>;
    const text = record.text;
    const outputText = record.output_text;
    const json = record.json;
    const refusal = record.refusal;
    const content = record.content;
    const output = record.output;

    if (typeof text === "string") {
      const trimmed = text.trim();

      if (trimmed) {
        textParts.push(trimmed);
      }
    }

    if (typeof outputText === "string") {
      const trimmed = outputText.trim();

      if (trimmed) {
        textParts.push(trimmed);
      }
    }

    if (typeof json === "string") {
      const trimmed = json.trim();

      if (trimmed) {
        textParts.push(trimmed);
      }
    } else if (json && typeof json === "object") {
      textParts.push(JSON.stringify(json));
    }

    if (typeof refusal === "string") {
      const trimmed = refusal.trim();

      if (trimmed) {
        textParts.push(trimmed);
      }
    }

    if (content !== undefined) {
      collect(content);
    }

    if (output !== undefined) {
      collect(output);
    }
  };

  if (!Array.isArray(body.output)) {
    collect(body);

    return textParts.length > 0 ? textParts.join("\n") : null;
  }

  for (const outputItem of body.output) {
    collect(outputItem);
  }

  return textParts.length > 0 ? textParts.join("") : null;
}

function parseJsonObject(text: string) {
  const trimmed = text.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  const parsed = JSON.parse(withoutFence) as unknown;

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Model response JSON was not an object");
  }

  return parsed as Record<string, unknown>;
}

function buildProviderRunIds(ids: {
  assemblyAiTranscriptId?: string | null;
  twelveLabsAnalysisTaskId?: string | null;
  geminiVideoEventResponseId?: string | null;
  openAiVisualResponseId?: string | null;
  openAiEditPlanResponseId?: string | null;
  openAiOverlayPlanResponseId?: string | null;
  openAiInstructionDocumentResponseId?: string | null;
  openAiScriptResponseId?: string | null;
  openAiTtsRequestId?: string | null;
  assemblyAiVoiceoverTranscriptId?: string | null;
}) {
  const providerRunIds: Record<string, string> = {};

  if (ids.assemblyAiTranscriptId) {
    providerRunIds.assemblyai_transcript_id = ids.assemblyAiTranscriptId;
  }

  if (ids.twelveLabsAnalysisTaskId) {
    providerRunIds.twelvelabs_analysis_task_id = ids.twelveLabsAnalysisTaskId;
  }

  if (ids.geminiVideoEventResponseId) {
    providerRunIds.gemini_video_event_response_id =
      ids.geminiVideoEventResponseId;
  }

  if (ids.openAiVisualResponseId) {
    providerRunIds.openai_visual_response_id = ids.openAiVisualResponseId;
  }

  if (ids.openAiEditPlanResponseId) {
    providerRunIds.openai_edit_plan_response_id =
      ids.openAiEditPlanResponseId;
  }

  if (ids.openAiOverlayPlanResponseId) {
    providerRunIds.openai_overlay_plan_response_id =
      ids.openAiOverlayPlanResponseId;
  }

  if (ids.openAiInstructionDocumentResponseId) {
    providerRunIds.openai_instruction_document_response_id =
      ids.openAiInstructionDocumentResponseId;
  }

  if (ids.openAiScriptResponseId) {
    providerRunIds.openai_script_response_id = ids.openAiScriptResponseId;
  }

  if (ids.openAiTtsRequestId) {
    providerRunIds.openai_tts_request_id = ids.openAiTtsRequestId;
  }

  if (ids.assemblyAiVoiceoverTranscriptId) {
    providerRunIds.assemblyai_voiceover_transcript_id =
      ids.assemblyAiVoiceoverTranscriptId;
  }

  return providerRunIds;
}

function compactTranscriptContext(transcript: AssemblyAiTranscriptResponse) {
  const text =
    typeof transcript.text === "string"
      ? transcript.text.slice(0, MAX_TRANSCRIPT_CONTEXT_CHARS)
      : "";
  const utterances = Array.isArray(transcript.utterances)
    ? transcript.utterances.slice(0, 20)
    : [];

  return {
    text,
    textWasTruncated:
      typeof transcript.text === "string" &&
      transcript.text.length > MAX_TRANSCRIPT_CONTEXT_CHARS,
    languageCode:
      typeof transcript.language_code === "string"
        ? transcript.language_code
        : null,
    utteranceSamples: utterances,
  };
}

function getTwelveLabsErrorMessage(body: unknown, fallback: string) {
  if (body && typeof body === "object" && "error" in body) {
    const error = (body as { error?: unknown }).error;

    if (typeof error === "string" && error.trim()) {
      return error;
    }

    if (error && typeof error === "object" && "message" in error) {
      const message = (error as { message?: unknown }).message;

      if (typeof message === "string" && message.trim()) {
        return message;
      }
    }
  }

  if (body && typeof body === "object" && "message" in body) {
    const message = (body as { message?: unknown }).message;

    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }

  if (typeof body === "string" && body.trim()) {
    return body;
  }

  return fallback;
}

function readTwelveLabsTaskId(body: unknown) {
  if (!isRecord(body)) {
    return null;
  }

  for (const key of ["task_id", "id", "_id", "taskId"]) {
    const value = body[key];

    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function buildTwelveLabsSegmentDefinition(options: {
  prompt: string;
  targetLanguage: string;
}) {
  return {
    id: "instruction_steps",
    description: [
      "Detect instructional machine-operation segments where the viewer needs to understand a visible action, physical adjustment, safety-relevant state, or final position.",
      `Editing intent: ${options.prompt}`,
      `Caption target language later in the pipeline: ${options.targetLanguage}`,
      "Prefer practical action boundaries that can become readable tutorial steps. Avoid long dead air, repeated explanation, unrelated setup, and purely conversational moments.",
    ].join(" "),
    fields: [
      {
        name: "title",
        type: "string",
        description: "A short editor-facing title for this action segment.",
      },
      {
        name: "description",
        type: "string",
        description:
          "What the viewer sees and why this action matters in the procedure.",
      },
      {
        name: "visible_action",
        type: "string",
        description:
          "The concrete hand, tool, screw, sensor, knob, UI, or machine movement visible in this segment.",
      },
      {
        name: "spoken_evidence",
        type: "string",
        description:
          "Any relevant speech or audio cue, or 'No speech evidence' if the segment is visual-only.",
      },
      {
        name: "importance",
        type: "string",
        enum: ["primary", "supporting", "context"],
        description:
          "primary for essential mechanical or safety actions, supporting for normal tutorial steps, context for setup or connector shots.",
      },
      {
        name: "confidence",
        type: "number",
        description: "Confidence from 0 to 1 that this is an instructional step.",
      },
    ],
  };
}

async function submitTwelveLabsAnalysisTask(options: {
  videoId: string;
  signedSourceUrl: string;
  prompt: string;
  targetLanguage: string;
}) {
  const { apiKey, baseUrl, model } = getTwelveLabsConfig();
  const customId = `blooclip_${options.videoId}`
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 64);
  const response = await fetch(`${baseUrl}/analyze/tasks`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      video: {
        type: "url",
        url: options.signedSourceUrl,
      },
      custom_id: customId,
      model_name: model,
      analysis_mode: "time_based_metadata",
      temperature: 0.2,
      max_tokens: 32768,
      min_segment_duration: 2,
      max_segment_duration: 8,
      response_format: {
        type: "segment_definitions",
        segment_definitions: [
          buildTwelveLabsSegmentDefinition({
            prompt: options.prompt,
            targetLanguage: options.targetLanguage,
          }),
        ],
      },
    }),
  });
  const body = await readJsonResponse(response);
  const taskId = readTwelveLabsTaskId(body);

  if (!response.ok) {
    throw new WorkerError(
      getTwelveLabsErrorMessage(
        body,
        `TwelveLabs analysis task creation failed with HTTP ${response.status}`
      ),
      {
        code: "twelvelabs_analysis_create_failed",
        provider: TWELVELABS_PROVIDER,
        providerRequestId: taskId ?? getProviderRequestId(response),
        retryable: response.status === 429 || response.status >= 500,
      }
    );
  }

  if (!taskId) {
    throw new WorkerError("TwelveLabs analysis task response was invalid", {
      code: "twelvelabs_analysis_create_response_invalid",
      provider: TWELVELABS_PROVIDER,
      providerRequestId: getProviderRequestId(response),
      retryable: true,
    });
  }

  return {
    taskId,
    model,
    rawResponse: body,
  };
}

async function pollTwelveLabsAnalysisTask(taskId: string) {
  const { apiKey, baseUrl } = getTwelveLabsConfig();
  const startedAt = Date.now();

  while (Date.now() - startedAt < TWELVELABS_ANALYSIS_TIMEOUT_MS) {
    const response = await fetch(
      `${baseUrl}/analyze/tasks/${encodeURIComponent(taskId)}`,
      {
        headers: {
          "x-api-key": apiKey,
        },
      }
    );
    const body = await readJsonResponse(response);

    if (!response.ok) {
      throw new WorkerError(
        getTwelveLabsErrorMessage(
          body,
          `TwelveLabs analysis poll failed with HTTP ${response.status}`
        ),
        {
          code: "twelvelabs_analysis_poll_failed",
          provider: TWELVELABS_PROVIDER,
          providerRequestId: taskId,
          retryable: response.status === 429 || response.status >= 500,
        }
      );
    }

    const status = isRecord(body) && typeof body.status === "string"
      ? body.status
      : null;

    if (status === "ready") {
      return body;
    }

    if (status === "failed") {
      throw new WorkerError(
        getTwelveLabsErrorMessage(body, "TwelveLabs analysis task failed"),
        {
          code: "twelvelabs_analysis_failed",
          provider: TWELVELABS_PROVIDER,
          providerRequestId: taskId,
          retryable: false,
        }
      );
    }

    await wait(TWELVELABS_POLL_INTERVAL_MS);
  }

  throw new WorkerError("TwelveLabs analysis task timed out", {
    code: "twelvelabs_analysis_timeout",
    provider: TWELVELABS_PROVIDER,
    providerRequestId: taskId,
    retryable: true,
  });
}

function parseTwelveLabsResultData(taskResponse: unknown) {
  if (!isRecord(taskResponse) || !isRecord(taskResponse.result)) {
    throw new WorkerError("TwelveLabs analysis result was missing", {
      code: "twelvelabs_analysis_result_missing",
      provider: TWELVELABS_PROVIDER,
      retryable: true,
    });
  }

  const data = taskResponse.result.data;

  if (typeof data === "string") {
    try {
      return JSON.parse(data) as unknown;
    } catch {
      throw new WorkerError("TwelveLabs analysis result JSON was invalid", {
        code: "twelvelabs_analysis_result_json_invalid",
        provider: TWELVELABS_PROVIDER,
        retryable: true,
      });
    }
  }

  if (isRecord(data)) {
    return data;
  }

  throw new WorkerError("TwelveLabs analysis result data was invalid", {
    code: "twelvelabs_analysis_result_invalid",
    provider: TWELVELABS_PROVIDER,
    retryable: true,
  });
}

function readMetadataString(
  metadata: Record<string, unknown>,
  key: string,
  fallback: string
) {
  const value = metadata[key];

  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function readMetadataConfidence(metadata: Record<string, unknown>) {
  const confidence = metadata.confidence;

  if (
    typeof confidence === "number" &&
    Number.isFinite(confidence) &&
    confidence >= 0 &&
    confidence <= 1
  ) {
    return confidence;
  }

  return 0.75;
}

function readTwelveLabsInstructionSegments(resultData: unknown) {
  if (!isRecord(resultData)) {
    return [];
  }

  const segments = resultData.instruction_steps;

  if (Array.isArray(segments)) {
    return segments;
  }

  const firstArray = Object.values(resultData).find(Array.isArray);

  return Array.isArray(firstArray) ? firstArray : [];
}

function normalizeTwelveLabsImportance(value: unknown) {
  return value === "primary" || value === "supporting" || value === "context"
    ? value
    : "supporting";
}

function buildVideoEventAnalysisFromTwelveLabs(options: {
  resultData: unknown;
  prompt: string;
  sourceDurationSeconds: number;
}) {
  const rawSegments = readTwelveLabsInstructionSegments(options.resultData);
  const events = rawSegments
    .flatMap((segment): Record<string, unknown>[] =>
      isRecord(segment) ? [segment] : []
    )
    .map((segment) => {
      const startSeconds = Number(segment.start_time ?? segment.startSeconds);
      const endSeconds = Number(segment.end_time ?? segment.endSeconds);
      const metadata = isRecord(segment.metadata) ? segment.metadata : {};

      return {
        startSeconds: Math.max(0, roundSeconds(startSeconds)),
        endSeconds: Math.min(
          options.sourceDurationSeconds,
          roundSeconds(endSeconds)
        ),
        metadata,
      };
    })
    .filter(
      (segment) =>
        Number.isFinite(segment.startSeconds) &&
        Number.isFinite(segment.endSeconds) &&
        segment.endSeconds > segment.startSeconds
    )
    .sort((a, b) => a.startSeconds - b.startSeconds)
    .map((segment, index) => {
      const eventIndex = index + 1;
      const metadata = segment.metadata;
      const description = readMetadataString(
        metadata,
        "description",
        "Instructional action detected by TwelveLabs."
      );
      const visualEvidence = readMetadataString(
        metadata,
        "visible_action",
        description
      );

      return {
        eventIndex,
        title: readMetadataString(
          metadata,
          "title",
          `Instruction step ${eventIndex}`
        ),
        description,
        startSeconds: segment.startSeconds,
        endSeconds: segment.endSeconds,
        importance: normalizeTwelveLabsImportance(metadata.importance),
        confidence: readMetadataConfidence(metadata),
        visualEvidence,
        transcriptEvidence: readMetadataString(
          metadata,
          "spoken_evidence",
          "No speech evidence"
        ),
      };
    });

  if (events.length === 0) {
    throw new WorkerError(
      "TwelveLabs analysis did not return any instructional segments",
      {
        code: "twelvelabs_analysis_segments_empty",
        provider: TWELVELABS_PROVIDER,
        retryable: true,
      }
    );
  }

  const primaryEvent =
    events.find((event) => event.importance === "primary") ?? events[0];
  const recommendedSegments = events.map((event, index) => ({
    segmentIndex: index + 1,
    eventIndex: event.eventIndex,
    sourceStart: event.startSeconds,
    sourceEnd: event.endSeconds,
    reason:
      event.importance === "context"
        ? "Useful setup context for the instruction sequence."
        : "Timestamped instructional action detected by TwelveLabs.",
    confidence: event.confidence,
  }));
  const omittedRanges = events.flatMap((event, index) => {
    const nextEvent = events[index + 1];

    if (!nextEvent || nextEvent.startSeconds - event.endSeconds < 1) {
      return [];
    }

    return [
      {
        sourceStart: event.endSeconds,
        sourceEnd: nextEvent.startSeconds,
        reason: "No instructional action detected between selected steps.",
      },
    ];
  });

  return validateVideoEventAnalysis(
    {
      summary: `TwelveLabs found ${events.length} timestamped instructional segments for: ${options.prompt}`,
      events,
      primaryEventIndex: primaryEvent.eventIndex,
      recommendedSegments,
      omittedRanges,
      warnings: [],
    },
    {
      sourceDurationSeconds: options.sourceDurationSeconds,
    }
  );
}

async function analyzeVideoEventsWithTwelveLabs(options: {
  videoId: string;
  sourceR2Key: string;
  transcriptR2Key: string;
  prompt: string;
  targetLanguage: string;
  durationSeconds: number;
}) {
  const signedSourceUrl = await createSignedR2ReadUrl(
    options.sourceR2Key,
    TWELVELABS_SIGNED_URL_EXPIRES_SECONDS
  );
  const task = await submitTwelveLabsAnalysisTask({
    videoId: options.videoId,
    signedSourceUrl,
    prompt: options.prompt,
    targetLanguage: options.targetLanguage,
  });
  const taskResponse = await pollTwelveLabsAnalysisTask(task.taskId);
  const resultData = parseTwelveLabsResultData(taskResponse);
  const validatedAnalysis = buildVideoEventAnalysisFromTwelveLabs({
    resultData,
    prompt: options.prompt,
    sourceDurationSeconds: options.durationSeconds,
  });

  return {
    videoId: options.videoId,
    sourceR2Key: options.sourceR2Key,
    transcriptR2Key: options.transcriptR2Key,
    provider: TWELVELABS_PROVIDER,
    providerRequestId: task.taskId,
    model: task.model,
    completedAt: new Date().toISOString(),
    sourceDurationSeconds: options.durationSeconds,
    prompt: options.prompt,
    targetLanguage: options.targetLanguage,
    ...validatedAnalysis,
    rawResponse: {
      createTask: task.rawResponse,
      task: taskResponse,
      data: resultData,
    },
  };
}

async function waitForGeminiFile(
  ai: GoogleGenAI,
  uploadedFile: GeminiFile,
  providerRequestId: string | null
) {
  if (!uploadedFile.name) {
    throw new WorkerError("Gemini file upload response was missing a file name", {
      code: "gemini_file_upload_response_invalid",
      provider: GEMINI_PROVIDER,
      providerRequestId,
      retryable: true,
    });
  }

  let file = uploadedFile;
  const startedAt = Date.now();

  while (Date.now() - startedAt < GEMINI_FILE_PROCESSING_TIMEOUT_MS) {
    if (file.state === FileState.FAILED) {
      throw new WorkerError(
        file.error?.message ?? "Gemini video file processing failed",
        {
          code: "gemini_file_processing_failed",
          provider: GEMINI_PROVIDER,
          providerRequestId: file.name,
          retryable: true,
        }
      );
    }

    if (file.uri && (!file.state || file.state === FileState.ACTIVE)) {
      return file;
    }

    await wait(GEMINI_FILE_POLL_INTERVAL_MS);
    file = await ai.files.get({ name: uploadedFile.name });
  }

  throw new WorkerError("Gemini video file processing timed out", {
    code: "gemini_file_processing_timeout",
    provider: GEMINI_PROVIDER,
    providerRequestId: uploadedFile.name,
    retryable: true,
  });
}

function buildVideoEventAnalysisInstructions(options: {
  prompt: string;
  targetLanguage: string;
  transcript: AssemblyAiTranscriptResponse;
  durationSeconds: number;
}) {
  return [
    "Analyze the full source video for a video editing pipeline.",
    "Return JSON only, following the required schema.",
    "Identify the key events across the whole video, not just isolated frames.",
    "The goal is to help a later edit planner preserve the most important tutorial or key-event moments.",
    "Use source-video timestamps in seconds for every event and recommended segment.",
    "Make timestamps precise enough for FFmpeg cutting, but do not invent certainty when the evidence is weak.",
    "Recommended segments should preserve setup context, key action, result/confirmation, and final outcome when relevant.",
    "For silent or unclear speech, write 'No speech evidence' in transcriptEvidence.",
    "Keep all text concise and in English for internal editor use.",
    "",
    `User prompt, the main editing intent: ${options.prompt}`,
    `Target language for later voiceover: ${options.targetLanguage}`,
    `Source video duration: ${options.durationSeconds}s`,
    "",
    "Transcript context from original audio:",
    JSON.stringify(compactTranscriptContext(options.transcript), null, 2),
  ].join("\n");
}

async function analyzeVideoEvents(options: {
  videoId: string;
  sourceR2Key: string;
  transcriptR2Key: string;
  inputPath: string;
  originalContentType: string;
  prompt: string;
  targetLanguage: string;
  transcript: AssemblyAiTranscriptResponse;
  durationSeconds: number;
}): Promise<VideoEventAnalysisArtifact> {
  const config = getGeminiConfig();

  if (!config.enabled || !config.apiKey) {
    throw new WorkerError("Gemini video event analysis is disabled", {
      code: "gemini_video_event_analysis_disabled",
      provider: GEMINI_PROVIDER,
      retryable: false,
    });
  }

  const ai = new GoogleGenAI({ apiKey: config.apiKey });
  let uploadedFile: GeminiFile | null = null;

  try {
    uploadedFile = await ai.files.upload({
      file: options.inputPath,
      config: {
        mimeType: options.originalContentType,
        displayName: `blooclip-${options.videoId}`,
      },
    });
    const activeFile = await waitForGeminiFile(
      ai,
      uploadedFile,
      uploadedFile.name ?? null
    );

    if (!activeFile.uri) {
      throw new WorkerError("Gemini file upload response was missing a URI", {
        code: "gemini_file_upload_response_invalid",
        provider: GEMINI_PROVIDER,
        providerRequestId: activeFile.name ?? uploadedFile.name ?? null,
        retryable: true,
      });
    }

    const videoPart: Part = {
      fileData: {
        fileUri: activeFile.uri,
        mimeType: activeFile.mimeType ?? options.originalContentType,
      },
    };

    const response = await ai.models.generateContent({
      model: config.model,
      contents: [
        {
          role: "user",
          parts: [
            videoPart,
            {
              text: buildVideoEventAnalysisInstructions(options),
            },
          ],
        },
      ],
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: VIDEO_EVENT_ANALYSIS_SCHEMA,
        maxOutputTokens: GEMINI_VIDEO_EVENT_ANALYSIS_MAX_OUTPUT_TOKENS,
        temperature: 0.2,
      },
    });

    const outputText = response.text;
    const providerRequestId = response.responseId ?? null;

    if (!outputText) {
      throw new WorkerError("Gemini video event analysis had no output text", {
        code: "gemini_video_event_analysis_output_missing",
        provider: GEMINI_PROVIDER,
        providerRequestId,
        retryable: true,
      });
    }

    let parsedOutput: Record<string, unknown>;

    try {
      parsedOutput = parseJsonObject(outputText);
    } catch (error) {
      throw new WorkerError(
        error instanceof Error
          ? error.message
          : "Gemini video event analysis JSON was invalid",
        {
          code: "gemini_video_event_analysis_json_invalid",
          provider: GEMINI_PROVIDER,
          providerRequestId,
          retryable: true,
        }
      );
    }

    try {
      const analysis = validateVideoEventAnalysis(parsedOutput, {
        sourceDurationSeconds: options.durationSeconds,
      });

      return {
        videoId: options.videoId,
        sourceR2Key: options.sourceR2Key,
        transcriptR2Key: options.transcriptR2Key,
        provider: GEMINI_PROVIDER,
        providerRequestId,
        model: response.modelVersion ?? config.model,
        completedAt: new Date().toISOString(),
        sourceDurationSeconds: options.durationSeconds,
        prompt: options.prompt,
        targetLanguage: options.targetLanguage,
        ...analysis,
        rawResponse: {
          responseId: response.responseId,
          modelVersion: response.modelVersion,
          promptFeedback: response.promptFeedback,
          candidates: response.candidates,
        },
        usage: response.usageMetadata,
      };
    } catch (error) {
      if (error instanceof VideoEventAnalysisValidationError) {
        throw new WorkerError(error.message, {
          code: "gemini_video_event_analysis_validation_failed",
          provider: GEMINI_PROVIDER,
          providerRequestId,
          retryable: true,
        });
      }

      throw error;
    }
  } catch (error) {
    if (error instanceof WorkerError) {
      throw error;
    }

    throw new WorkerError(
      error instanceof Error
        ? error.message
        : "Gemini video event analysis failed",
      {
        code: "gemini_video_event_analysis_failed",
        provider: GEMINI_PROVIDER,
        providerRequestId: uploadedFile?.name ?? null,
        retryable: true,
      }
    );
  } finally {
    if (uploadedFile?.name) {
      try {
        await ai.files.delete({ name: uploadedFile.name });
      } catch (error) {
        console.warn(
          `Failed to delete Gemini file ${uploadedFile.name}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  }
}

function buildVisualAnalysisInstructions(options: {
  prompt: string;
  targetLanguage: string;
  transcript: AssemblyAiTranscriptResponse;
  frames: SampledFrame[];
}) {
  return [
    "Analyze sampled still frames from a source video for an editing pipeline.",
    "You are receiving image frames with timestamps, not raw video input.",
    "Do not infer motion or events that are not visible in the sampled frames.",
    "Return JSON only, following the required schema.",
    "Use concise English descriptions for internal editor use.",
    "Candidate moments are rough visual cues for a future edit-planning step; do not create a final edit plan.",
    "",
    `User prompt: ${options.prompt}`,
    `Target language for later voiceover: ${options.targetLanguage}`,
    `Frames: ${options.frames
      .map((frame) => `${frame.index} at ${frame.timestampSeconds}s`)
      .join(", ")}`,
    "",
    "Transcript context from original audio:",
    JSON.stringify(compactTranscriptContext(options.transcript), null, 2),
  ].join("\n");
}

async function analyzeVisualTimeline(options: {
  videoId: string;
  sourceR2Key: string;
  transcriptR2Key: string;
  prompt: string;
  targetLanguage: string;
  transcript: AssemblyAiTranscriptResponse;
  sampledFrames: SampledFrame[];
  durationSeconds: number;
  intervalSeconds: number;
  maxFrames: number;
}) {
  const { apiKey, baseUrl, model, reasoningEffort, imageDetail, maxOutputTokens } =
    getOpenAiConfig();
  const content: Record<string, unknown>[] = [
    {
      type: "input_text",
      text: buildVisualAnalysisInstructions({
        prompt: options.prompt,
        targetLanguage: options.targetLanguage,
        transcript: options.transcript,
        frames: options.sampledFrames,
      }),
    },
  ];

  for (const frame of options.sampledFrames) {
    const frameBytes = await readFile(frame.filePath);

    content.push({
      type: "input_text",
      text: `Frame ${frame.index}, timestamp ${frame.timestampSeconds}s`,
    });
    content.push({
      type: "input_image",
      image_url: `data:image/jpeg;base64,${frameBytes.toString("base64")}`,
      detail: imageDetail,
    });
  }

  const response = await fetchOpenAi(
    `${baseUrl}/responses`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        reasoning: { effort: reasoningEffort },
        input: [
          {
            role: "user",
            content,
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "visual_timeline",
            strict: true,
            schema: VISUAL_TIMELINE_SCHEMA,
          },
        },
        max_output_tokens: maxOutputTokens.visualAnalysis,
        store: false,
      }),
    },
    {
      code: "openai_visual_analysis_failed",
      failureMessage: "OpenAI visual analysis request failed after retries",
    }
  );

  const body = (await readJsonResponse(response)) as OpenAiResponsesResponse;
  const requestId = getProviderRequestId(response);

  if (!response.ok) {
    throw new WorkerError(
      getOpenAiErrorMessage(
        body,
        `OpenAI visual analysis failed with HTTP ${response.status}`
      ),
      {
        code: "openai_visual_analysis_failed",
        provider: OPENAI_PROVIDER,
        providerRequestId: requestId,
        retryable: response.status === 429 || response.status >= 500,
      }
    );
  }

  if (body.status === "incomplete") {
    throw new WorkerError(
      "OpenAI visual analysis response was incomplete before valid JSON was returned",
      {
        code: "openai_visual_analysis_incomplete",
        provider: OPENAI_PROVIDER,
        providerRequestId:
          typeof body.id === "string" ? body.id : requestId ?? null,
        retryable: true,
      }
    );
  }

  const outputText = body ? extractOpenAiOutputText(body) : null;

  if (!outputText) {
    throw new WorkerError("OpenAI visual analysis response had no output text", {
      code: "openai_visual_analysis_output_missing",
      provider: OPENAI_PROVIDER,
      providerRequestId:
        typeof body?.id === "string" ? body.id : requestId ?? null,
      retryable: true,
    });
  }

  let parsedOutput: Record<string, unknown>;

  try {
    parsedOutput = parseJsonObject(outputText);
  } catch (error) {
    throw new WorkerError(
      error instanceof Error
        ? error.message
        : "OpenAI visual analysis JSON was invalid",
      {
        code: "openai_visual_analysis_json_invalid",
        provider: OPENAI_PROVIDER,
        providerRequestId:
          typeof body?.id === "string" ? body.id : requestId ?? null,
        retryable: true,
      }
    );
  }

  return {
    videoId: options.videoId,
    sourceR2Key: options.sourceR2Key,
    transcriptR2Key: options.transcriptR2Key,
    provider: OPENAI_PROVIDER,
    providerRequestId: typeof body?.id === "string" ? body.id : requestId,
    model,
    completedAt: new Date().toISOString(),
    sampling: {
      durationSeconds: options.durationSeconds,
      intervalSeconds: options.intervalSeconds,
      maxFrames: options.maxFrames,
      frameCount: options.sampledFrames.length,
    },
    prompt: options.prompt,
    targetLanguage: options.targetLanguage,
    frames: options.sampledFrames.map((frame) => ({
      index: frame.index,
      timestampSeconds: frame.timestampSeconds,
      r2Key: frame.r2Key,
      sizeBytes: frame.sizeBytes,
    })),
    analysis: parsedOutput,
    rawResponse: body,
  };
}

type VisualTimelineArtifact = Awaited<ReturnType<typeof analyzeVisualTimeline>>;

function compactTranscriptForEditPlan(transcript: AssemblyAiTranscriptResponse) {
  return {
    ...compactTranscriptContext(transcript),
    utterances: Array.isArray(transcript.utterances)
      ? transcript.utterances.slice(0, MAX_EDIT_PLAN_UTTERANCES)
      : [],
    words: Array.isArray(transcript.words)
      ? transcript.words.slice(0, MAX_EDIT_PLAN_WORDS)
      : [],
  };
}

function compactVisualTimelineForEditPlan(
  visualTimeline: VisualTimelineArtifact
) {
  return {
    sampling: visualTimeline.sampling,
    frames: visualTimeline.frames,
    analysis: visualTimeline.analysis,
  };
}

function compactVideoEventAnalysisForEditPlan(
  videoEventAnalysis: VideoEventAnalysisArtifact | null | undefined
) {
  if (!videoEventAnalysis) {
    return null;
  }

  return {
    summary: videoEventAnalysis.summary,
    primaryEventIndex: videoEventAnalysis.primaryEventIndex,
    events: videoEventAnalysis.events,
    recommendedSegments: videoEventAnalysis.recommendedSegments,
    omittedRanges: videoEventAnalysis.omittedRanges,
    warnings: videoEventAnalysis.warnings,
  };
}

function buildEditPlanInstructions(options: {
  prompt: string;
  targetLanguage: string;
  transcript: AssemblyAiTranscriptResponse;
  visualTimeline: VisualTimelineArtifact;
  videoEventAnalysis?: VideoEventAnalysisArtifact | null;
  durationSeconds: number;
}) {
  return [
    "Create a tutorial-preserving edit plan for a video assembly pipeline.",
    "Return JSON only, following the required schema.",
    "This is not a generic highlight reel. Preserve tutorial logic and viewer understanding.",
    "You are receiving transcript timing, sampled-frame visual analysis, and optional whole-video Gemini event analysis.",
    "",
    `User prompt, the main editing intent: ${options.prompt}`,
    `Target language for later voiceover: ${options.targetLanguage}`,
    `Source video duration: ${options.durationSeconds}s`,
    "",
    "Planning behavior:",
    "1. First infer tutorialGoal from the user prompt, transcript, and visual timeline.",
    "2. Then identify the logical tutorial step sequence.",
    "3. Then select chronological source video segments that preserve that sequence.",
    "4. The selected segments must still feel like a complete tutorial after trimming.",
    "5. Preserve setup context, key actions, UI or physical state changes, action/result pairs, confirmations, and final outcome moments.",
    "6. Remove or shorten dead air, loading waits, repeated explanation, mistakes, duplicated shots, and irrelevant tangents only when viewer understanding remains intact.",
    "7. Prefer 3-8 selected segments, but allow fewer or more when tutorial clarity requires it.",
    "8. segments must contain at least one selected segment. Zero segments is invalid in all cases.",
    "9. If tutorial evidence is weak, create one fallback tutorial step named Best Available Tutorial Context, select the best available chronological source range, and add a warning. Do not return an empty segment list.",
    "10. When Gemini video event analysis is available, use it as the high-level signal for what matters across the whole video.",
    "11. AssemblyAI transcript remains the timing and semantic evidence for spoken steps.",
    "12. OpenAI sampled-frame timeline remains corroborating visual evidence; do not let sparse frames override a stronger whole-video event unless transcript timing contradicts it.",
    "13. Keep titles, objectives, reasons, evidence, omittedContent reasons, and warnings concise.",
    "14. Prefer no more than 8 tutorialSteps, 8 selected segments, and 8 omittedContent entries.",
    "",
    "Segment timing rules:",
    "- sourceStart and sourceEnd are in source video seconds.",
    "- Every selected segment must satisfy 0 <= sourceStart < sourceEnd <= source video duration.",
    "- Selected segments must be ordered chronologically and must not overlap.",
    "- Keep sourceStart and sourceEnd precise enough for FFmpeg cutting.",
    "",
    "Transcript context with timing evidence:",
    JSON.stringify(compactTranscriptForEditPlan(options.transcript), null, 2),
    "",
    options.videoEventAnalysis
      ? "Gemini whole-video event analysis:"
      : "Gemini whole-video event analysis: not available; continue with transcript and sampled-frame evidence.",
    options.videoEventAnalysis
      ? JSON.stringify(
          compactVideoEventAnalysisForEditPlan(options.videoEventAnalysis),
          null,
          2
        )
      : "",
    "",
    "Visual timeline context:",
    JSON.stringify(
      compactVisualTimelineForEditPlan(options.visualTimeline),
      null,
      2
    ),
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function throwEditPlanValidationError(
  message: string,
  providerRequestId: string | null
): never {
  throw new WorkerError(message, {
    code: "openai_edit_plan_validation_failed",
    provider: OPENAI_PROVIDER,
    providerRequestId,
    retryable: true,
  });
}

function validateEditPlan(
  editPlan: Record<string, unknown>,
  durationSeconds: number,
  providerRequestId: string | null
) {
  const tutorialSteps = editPlan.tutorialSteps;

  if (!Array.isArray(tutorialSteps) || tutorialSteps.length === 0) {
    throwEditPlanValidationError(
      "OpenAI edit plan must contain at least one tutorial step",
      providerRequestId
    );
  }

  const tutorialStepIndexes = new Set<number>();

  for (const [index, tutorialStep] of tutorialSteps.entries()) {
    const tutorialStepNumber = index + 1;

    if (!isRecord(tutorialStep)) {
      throwEditPlanValidationError(
        `OpenAI edit plan tutorial step ${tutorialStepNumber} was invalid`,
        providerRequestId
      );
    }

    const stepIndex = tutorialStep.stepIndex;

    if (
      typeof stepIndex !== "number" ||
      !Number.isInteger(stepIndex) ||
      stepIndex <= 0
    ) {
      throwEditPlanValidationError(
        `OpenAI edit plan tutorial step ${tutorialStepNumber} has an invalid stepIndex`,
        providerRequestId
      );
    }

    tutorialStepIndexes.add(stepIndex);
  }

  const segments = editPlan.segments;

  if (!Array.isArray(segments) || segments.length === 0) {
    throwEditPlanValidationError(
      "OpenAI edit plan must contain at least one selected segment",
      providerRequestId
    );
  }

  let previousStart = -Infinity;
  let previousEnd = -Infinity;

  for (const [index, segment] of segments.entries()) {
    const segmentNumber = index + 1;

    if (!isRecord(segment)) {
      throwEditPlanValidationError(
        `OpenAI edit plan segment ${segmentNumber} was invalid`,
        providerRequestId
      );
    }

    const segmentIndex = segment.segmentIndex;
    const tutorialStepIndex = segment.tutorialStepIndex;
    const sourceStart = segment.sourceStart;
    const sourceEnd = segment.sourceEnd;
    const confidence = segment.confidence;

    if (
      typeof segmentIndex !== "number" ||
      !Number.isInteger(segmentIndex) ||
      segmentIndex <= 0
    ) {
      throwEditPlanValidationError(
        `OpenAI edit plan segment ${segmentNumber} has an invalid segmentIndex`,
        providerRequestId
      );
    }

    if (
      typeof tutorialStepIndex !== "number" ||
      !Number.isInteger(tutorialStepIndex) ||
      !tutorialStepIndexes.has(tutorialStepIndex)
    ) {
      throwEditPlanValidationError(
        `OpenAI edit plan segment ${segmentNumber} references a missing tutorial step`,
        providerRequestId
      );
    }

    if (typeof sourceStart !== "number" || typeof sourceEnd !== "number") {
      throwEditPlanValidationError(
        `OpenAI edit plan segment ${segmentNumber} is missing sourceStart or sourceEnd`,
        providerRequestId
      );
    }

    if (!Number.isFinite(sourceStart) || !Number.isFinite(sourceEnd)) {
      throwEditPlanValidationError(
        `OpenAI edit plan segment ${segmentNumber} has non-finite timestamps`,
        providerRequestId
      );
    }

    if (sourceEnd <= sourceStart) {
      throwEditPlanValidationError(
        `OpenAI edit plan segment ${segmentNumber} has an empty or negative duration`,
        providerRequestId
      );
    }

    if (sourceEnd - sourceStart < MIN_EDIT_SEGMENT_DURATION_SECONDS) {
      throwEditPlanValidationError(
        `OpenAI edit plan segment ${segmentNumber} is too short to render safely`,
        providerRequestId
      );
    }

    if (sourceStart < 0 || sourceEnd > durationSeconds) {
      throwEditPlanValidationError(
        `OpenAI edit plan segment ${segmentNumber} is outside the source video duration`,
        providerRequestId
      );
    }

    if (sourceStart < previousStart) {
      throwEditPlanValidationError(
        `OpenAI edit plan segment ${segmentNumber} is not in chronological order`,
        providerRequestId
      );
    }

    if (sourceStart < previousEnd) {
      throwEditPlanValidationError(
        `OpenAI edit plan segment ${segmentNumber} overlaps the previous segment`,
        providerRequestId
      );
    }

    if (
      typeof confidence !== "number" ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1
    ) {
      throwEditPlanValidationError(
        `OpenAI edit plan segment ${segmentNumber} has invalid confidence`,
        providerRequestId
      );
    }

    previousStart = sourceStart;
    previousEnd = sourceEnd;
  }
}

async function planTutorialSegments(options: {
  videoId: string;
  sourceR2Key: string;
  transcriptR2Key: string;
  visualTimelineR2Key: string;
  videoEventAnalysisR2Key?: string | null;
  prompt: string;
  targetLanguage: string;
  transcript: AssemblyAiTranscriptResponse;
  visualTimeline: VisualTimelineArtifact;
  videoEventAnalysis?: VideoEventAnalysisArtifact | null;
  durationSeconds: number;
}) {
  const { apiKey, baseUrl, model, reasoningEffort, maxOutputTokens } =
    getOpenAiConfig();
  const response = await fetchOpenAi(
    `${baseUrl}/responses`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        reasoning: { effort: reasoningEffort },
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: buildEditPlanInstructions(options),
              },
            ],
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "tutorial_edit_plan",
            strict: true,
            schema: EDIT_PLAN_SCHEMA,
          },
        },
        max_output_tokens: maxOutputTokens.editPlan,
        store: false,
      }),
    },
    {
      code: "openai_edit_plan_failed",
      failureMessage: "OpenAI edit planning request failed after retries",
    }
  );

  const body = (await readJsonResponse(response)) as OpenAiResponsesResponse;
  const requestId = getProviderRequestId(response);

  if (!response.ok) {
    throw new WorkerError(
      getOpenAiErrorMessage(
        body,
        `OpenAI edit planning failed with HTTP ${response.status}`
      ),
      {
        code: "openai_edit_plan_failed",
        provider: OPENAI_PROVIDER,
        providerRequestId: requestId,
        retryable: response.status === 429 || response.status >= 500,
      }
    );
  }

  const providerRequestId =
    typeof body?.id === "string" ? body.id : requestId ?? null;

  if (body.status === "incomplete") {
    const details =
      body.incomplete_details && typeof body.incomplete_details === "object"
        ? `: ${JSON.stringify(body.incomplete_details)}`
        : "";

    throw new WorkerError(
      `OpenAI edit planning response was incomplete before valid JSON was returned${details}`,
      {
        code: "openai_edit_plan_incomplete",
        provider: OPENAI_PROVIDER,
        providerRequestId,
        retryable: true,
      }
    );
  }

  const outputText = body ? extractOpenAiOutputText(body) : null;

  if (!outputText) {
    throw new WorkerError("OpenAI edit planning response had no output text", {
      code: "openai_edit_plan_output_missing",
      provider: OPENAI_PROVIDER,
      providerRequestId,
      retryable: true,
    });
  }

  let parsedOutput: Record<string, unknown>;

  try {
    parsedOutput = parseJsonObject(outputText);
  } catch (error) {
    throw new WorkerError(
      error instanceof Error
        ? error.message
        : "OpenAI edit plan JSON was invalid",
      {
        code: "openai_edit_plan_json_invalid",
        provider: OPENAI_PROVIDER,
        providerRequestId,
        retryable: true,
      }
    );
  }

  validateEditPlan(parsedOutput, options.durationSeconds, providerRequestId);

  return {
    videoId: options.videoId,
    sourceR2Key: options.sourceR2Key,
    transcriptR2Key: options.transcriptR2Key,
    visualTimelineR2Key: options.visualTimelineR2Key,
    videoEventAnalysisR2Key: options.videoEventAnalysisR2Key ?? null,
    provider: OPENAI_PROVIDER,
    providerRequestId,
    model,
    completedAt: new Date().toISOString(),
    planningMode: "tutorial_key_steps",
    sourceDurationSeconds: options.durationSeconds,
    prompt: options.prompt,
    targetLanguage: options.targetLanguage,
    ...parsedOutput,
    rawResponse: body,
  };
}

type EditPlanArtifact = Awaited<ReturnType<typeof planTutorialSegments>> &
  Record<string, unknown>;

function compactEditPlanForOverlayPlan(editPlan: EditPlanArtifact) {
  return {
    tutorialGoal: editPlan.tutorialGoal,
    tutorialSteps: editPlan.tutorialSteps,
    segments: editPlan.segments,
    warnings: editPlan.warnings,
  };
}

function buildInstructionOverlayPlanInstructions(options: {
  prompt: string;
  targetLanguage: string;
  transcript: AssemblyAiTranscriptResponse;
  visualTimeline: VisualTimelineArtifact;
  videoEventAnalysis?: VideoEventAnalysisArtifact | null;
  editPlan: EditPlanArtifact;
}) {
  return [
    "Create a Vidocu-style instruction overlay render plan for an already selected tutorial edit.",
    "Return JSON only, following the required schema.",
    "Do not change sourceStart or sourceEnd. Use the selected edit-plan segments as fixed visual clips.",
    "Create exactly one overlay segment for each selected edit-plan segment.",
    "",
    `User prompt: ${options.prompt}`,
    `Target language: ${options.targetLanguage}`,
    "",
    "Caption rules:",
    "- Each overlayCaption is a visual instruction, not a subtitle transcript.",
    "- English captions should be 8-18 words and fit in at most 2 lines.",
    "- Chinese captions should be short, practical, and fit in 1-2 lines.",
    "- Describe the visible action at that moment. Prefer verbs like loosen, slide, align, tighten, check, press, lift, connect, remove, install, and confirm.",
    "- Do not mention timing, camera, clip, frame, AI, transcript, or source evidence in the caption.",
    "- Do not make captions decorative or marketing-like.",
    "",
    "Rhythm rules:",
    "- Normal step clip: 3-6 seconds.",
    "- Quick connector clip: 1-2.5 seconds.",
    "- Important mechanical or safety action: 5-8 seconds.",
    "- Add 0.3-0.6 seconds of holdAfterActionSeconds after key mechanical, alignment, or safety actions.",
    "- Use 0-0.2 seconds hold for quick connectors.",
    "- captionStart and captionEnd are seconds relative to the selected segment after trimming.",
    "- Let captions cover the action and the short hold when useful.",
    "",
    "Visual rules:",
    "- transitionToNext should usually be { type: 'hard_cut', durationFrames: 0 }.",
    "- Only use { type: 'fade', durationFrames: 6-10 } if a cut would feel visually harsh.",
    "- optionalCrop.type should be 'none' unless the shot is static and wide.",
    "- If using optionalCrop subtle_zoom, keep scale at 1.02-1.08 and do not hide hands, screws, sensors, knobs, tools, or machine reference points.",
    "",
    "Transcript context:",
    JSON.stringify(compactTranscriptForEditPlan(options.transcript), null, 2),
    "",
    options.videoEventAnalysis
      ? "Whole-video event analysis:"
      : "Whole-video event analysis: not available.",
    options.videoEventAnalysis
      ? JSON.stringify(
          compactVideoEventAnalysisForEditPlan(options.videoEventAnalysis),
          null,
          2
        )
      : "",
    "",
    "Visual timeline context:",
    JSON.stringify(
      compactVisualTimelineForEditPlan(options.visualTimeline),
      null,
      2
    ),
    "",
    "Fixed selected edit plan:",
    JSON.stringify(compactEditPlanForOverlayPlan(options.editPlan), null, 2),
  ].join("\n");
}

async function planInstructionOverlays(options: {
  videoId: string;
  sourceR2Key: string;
  editPlanR2Key: string;
  prompt: string;
  targetLanguage: string;
  transcript: AssemblyAiTranscriptResponse;
  visualTimeline: VisualTimelineArtifact;
  videoEventAnalysis?: VideoEventAnalysisArtifact | null;
  editPlan: EditPlanArtifact;
}) {
  const selectedSegments = getSelectedSegmentReferences(options.editPlan);

  if (selectedSegments.length === 0) {
    throw new WorkerError(
      "Edit plan did not contain selected segments for instruction overlays",
      {
        code: "instruction_overlay_segments_missing",
        provider: OPENAI_PROVIDER,
        retryable: true,
      }
    );
  }

  const { apiKey, baseUrl, model, reasoningEffort, maxOutputTokens } =
    getOpenAiConfig();
  const response = await fetchOpenAi(
    `${baseUrl}/responses`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        reasoning: { effort: reasoningEffort },
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: buildInstructionOverlayPlanInstructions(options),
              },
            ],
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "instruction_overlay_plan",
            strict: true,
            schema: INSTRUCTION_OVERLAY_PLAN_SCHEMA,
          },
        },
        max_output_tokens: maxOutputTokens.overlayPlan,
        store: false,
      }),
    },
    {
      code: "openai_instruction_overlay_plan_failed",
      failureMessage:
        "OpenAI instruction overlay planning request failed after retries",
    }
  );
  const body = (await readJsonResponse(response)) as OpenAiResponsesResponse;
  const requestId = getProviderRequestId(response);

  if (!response.ok) {
    throw new WorkerError(
      getOpenAiErrorMessage(
        body,
        `OpenAI instruction overlay planning failed with HTTP ${response.status}`
      ),
      {
        code: "openai_instruction_overlay_plan_failed",
        provider: OPENAI_PROVIDER,
        providerRequestId: requestId,
        retryable: response.status === 429 || response.status >= 500,
      }
    );
  }

  const providerRequestId =
    typeof body?.id === "string" ? body.id : requestId ?? null;

  if (body.status === "incomplete") {
    throw new WorkerError(
      "OpenAI instruction overlay planning response was incomplete before valid JSON was returned",
      {
        code: "openai_instruction_overlay_plan_incomplete",
        provider: OPENAI_PROVIDER,
        providerRequestId,
        retryable: true,
      }
    );
  }

  const outputText = body ? extractOpenAiOutputText(body) : null;

  if (!outputText) {
    throw new WorkerError(
      "OpenAI instruction overlay planning response had no output text",
      {
        code: "openai_instruction_overlay_plan_output_missing",
        provider: OPENAI_PROVIDER,
        providerRequestId,
        retryable: true,
      }
    );
  }

  let parsedOutput: Record<string, unknown>;

  try {
    parsedOutput = parseJsonObject(outputText);
  } catch (error) {
    throw new WorkerError(
      error instanceof Error
        ? error.message
        : "OpenAI instruction overlay plan JSON was invalid",
      {
        code: "openai_instruction_overlay_plan_json_invalid",
        provider: OPENAI_PROVIDER,
        providerRequestId,
        retryable: true,
      }
    );
  }

  let overlayPlan: InstructionOverlayPlan;

  try {
    overlayPlan = validateInstructionOverlayPlan(parsedOutput, {
      selectedSegments,
      targetLanguage: options.targetLanguage,
    });
  } catch (error) {
    if (error instanceof InstructionOverlayPlanValidationError) {
      throw new WorkerError(error.message, {
        code: "openai_instruction_overlay_plan_validation_failed",
        provider: OPENAI_PROVIDER,
        providerRequestId,
        retryable: true,
      });
    }

    throw error;
  }

  return {
    videoId: options.videoId,
    sourceR2Key: options.sourceR2Key,
    editPlanR2Key: options.editPlanR2Key,
    provider: OPENAI_PROVIDER,
    providerRequestId,
    model,
    completedAt: new Date().toISOString(),
    instructionOverlayPlan: overlayPlan,
    rawResponse: body,
  };
}

type InstructionFrameAsset = {
  stepIndex: number;
  filePath: string;
  r2Key: string;
  sizeBytes: number;
  timestampSeconds: number;
};

function compactEditPlanForInstructionDocument(editPlan: EditPlanArtifact) {
  return {
    tutorialGoal: editPlan.tutorialGoal,
    tutorialSteps: editPlan.tutorialSteps,
    segments: editPlan.segments,
    warnings: editPlan.warnings,
  };
}

function buildInstructionDocumentInstructions(options: {
  prompt: string;
  targetLanguage: string;
  transcript: AssemblyAiTranscriptResponse;
  visualTimeline: VisualTimelineArtifact;
  editPlan: EditPlanArtifact;
  sampledFrames: SampledFrame[];
  durationSeconds: number;
}) {
  return [
    "Create a professional customer-facing operating manual from a tutorial video.",
    "Return JSON only, following the required schema.",
    "Write all user-facing text in the requested target language.",
    "The targetLanguage field must exactly match the requested target language value.",
    "Do not return markdown, HTML, raw script, or unsafe markup-like text.",
    "Use an official manufacturer-style tone: formal, concise, instructional, and procedural.",
    "Focus on operating, installation, maintenance, and troubleshooting procedures.",
    "Convert observed actions into authoritative step instructions.",
    "Do not include video analysis explanation, transcript interpretation notes, timestamps, frame numbers, AI observations, or uncertainty statements.",
    "Do not include document number, version number, revision history, release date, technical generation notes, source limitations, or limitations sections.",
    "Each step must reference exactly one key frame from the provided sampled frame list.",
    "For keyFrame.timestampSeconds, copy the exact timestamp for the referenced visualFrameIndex.",
    "Use the edit plan as the source of truth for the step order and supporting source ranges.",
    "Required top-level sections:",
    "- title: equipment name.",
    "- overview: operating purpose and scope.",
    "- safetyPrecautions: list.",
    "- requiredToolsAndComponents: list.",
    "- steps: ordered list where each step has:",
    "  - title: step heading",
    "  - purpose: objective and expected outcome of the step",
    "  - procedure: step actions in imperative form",
    "  - inspectionCriteria: checks to validate completion of the step",
    "  - importantNotes: required list of practical notes; use [] when there are no notes",
    "- finalInspectionChecklist: checks after all steps",
    "- maintenanceRecommendations: post-operations maintenance points",
    "Avoid mentioning source-video timestamps or frame timing in step text.",
    `Return at most ${MAX_INSTRUCTION_DOCUMENT_STEPS} instruction steps.`,
    "",
    `User prompt: ${options.prompt}`,
    `Target language: ${options.targetLanguage}`,
    `Source video duration: ${options.durationSeconds}s`,
    "",
    "Sampled frame references available for keyFrame.visualFrameIndex:",
    JSON.stringify(
      options.sampledFrames.map((frame) => ({
        visualFrameIndex: frame.index,
        timestampSeconds: frame.timestampSeconds,
      })),
      null,
      2
    ),
    "",
    "Transcript context:",
    JSON.stringify(compactTranscriptForEditPlan(options.transcript), null, 2),
    "",
    "Visual timeline context:",
    JSON.stringify(
      compactVisualTimelineForEditPlan(options.visualTimeline),
      null,
      2
    ),
    "",
    "Selected edit plan:",
    JSON.stringify(compactEditPlanForInstructionDocument(options.editPlan), null, 2),
  ].join("\n");
}

async function generateInstructionDocument(options: {
  videoId: string;
  sourceR2Key: string;
  transcriptR2Key: string;
  visualTimelineR2Key: string;
  editPlanR2Key: string;
  prompt: string;
  targetLanguage: string;
  transcript: AssemblyAiTranscriptResponse;
  visualTimeline: VisualTimelineArtifact;
  editPlan: EditPlanArtifact;
  sampledFrames: SampledFrame[];
  durationSeconds: number;
}) {
  const { apiKey, baseUrl, model, reasoningEffort, maxOutputTokens } =
    getOpenAiConfig();
  const response = await fetchOpenAi(
    `${baseUrl}/responses`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        reasoning: { effort: reasoningEffort },
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: buildInstructionDocumentInstructions(options),
              },
            ],
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "instruction_document",
            strict: true,
            schema: INSTRUCTION_DOCUMENT_SCHEMA,
          },
        },
        max_output_tokens: maxOutputTokens.instructionDocument,
        store: false,
      }),
    },
    {
      code: "openai_instruction_document_failed",
      failureMessage:
        "OpenAI instruction document generation request failed after retries",
    }
  );

  const body = (await readJsonResponse(response)) as OpenAiResponsesResponse;
  const requestId = getProviderRequestId(response);

  if (!response.ok) {
    throw new WorkerError(
      getOpenAiErrorMessage(
        body,
        `OpenAI instruction document generation failed with HTTP ${response.status}`
      ),
      {
        code: "openai_instruction_document_failed",
        provider: OPENAI_PROVIDER,
        providerRequestId: requestId,
        retryable: response.status === 429 || response.status >= 500,
      }
    );
  }

  const outputText = body ? extractOpenAiOutputText(body) : null;
  const providerRequestId =
    typeof body?.id === "string" ? body.id : requestId ?? null;

  if (!outputText) {
    throw new WorkerError(
      "OpenAI instruction document response had no output text",
      {
        code: "openai_instruction_document_output_missing",
        provider: OPENAI_PROVIDER,
        providerRequestId,
        retryable: true,
      }
    );
  }

  let parsedOutput: Record<string, unknown>;

  try {
    parsedOutput = parseJsonObject(outputText);
  } catch (error) {
    throw new WorkerError(
      error instanceof Error
        ? error.message
        : "OpenAI instruction document JSON was invalid",
      {
        code: "openai_instruction_document_json_invalid",
        provider: OPENAI_PROVIDER,
        providerRequestId,
        retryable: true,
      }
    );
  }

  let document: InstructionDocument;

  try {
    document = validateInstructionDocument(parsedOutput, {
      requestedTargetLanguage: options.targetLanguage,
      sourceDurationSeconds: options.durationSeconds,
      frameReferences: options.sampledFrames.map((frame) => ({
        index: frame.index,
        timestampSeconds: frame.timestampSeconds,
      })),
      maxSteps: MAX_INSTRUCTION_DOCUMENT_STEPS,
    });
  } catch (error) {
    if (error instanceof InstructionDocumentValidationError) {
      throw new WorkerError(error.message, {
        code: "openai_instruction_document_validation_failed",
        provider: OPENAI_PROVIDER,
        providerRequestId,
        retryable: true,
      });
    }

    throw error;
  }

  return {
    document,
    providerRequestId,
    model,
    rawResponse: body,
  };
}

type RenderSegment = {
  index: number;
  sourceStart: number;
  sourceEnd: number;
  sourceDurationSeconds: number;
  durationSeconds: number;
  holdAfterActionSeconds: number;
  optionalCrop: InstructionOverlayRenderPlan["segments"][number]["optionalCrop"] | null;
};

async function resolveBrandLanguageContext(
  _videoId: string,
  targetLanguage: string
): Promise<BrandLanguageContext> {
  return {
    source: "none",
    version: null,
    targetLanguage,
    glossaryRules: [],
    pronunciationDictionaryLocators: [],
  };
}

function getSelectedDurationSeconds(editPlan: EditPlanArtifact) {
  const segments = Array.isArray(editPlan.segments) ? editPlan.segments : [];
  const overlayPlan = isRecord(editPlan.instructionOverlayPlan)
    ? editPlan.instructionOverlayPlan
    : null;
  const overlaySegments = isRecord(overlayPlan) && Array.isArray(overlayPlan.segments)
    ? overlayPlan.segments
    : [];
  const holdSecondsBySegmentIndex = new Map<number, number>();

  for (const overlaySegment of overlaySegments) {
    if (!isRecord(overlaySegment)) {
      continue;
    }

    const segmentIndex = overlaySegment.segmentIndex;
    const holdAfterActionSeconds = overlaySegment.holdAfterActionSeconds;

    if (
      typeof segmentIndex === "number" &&
      typeof holdAfterActionSeconds === "number" &&
      Number.isFinite(holdAfterActionSeconds)
    ) {
      holdSecondsBySegmentIndex.set(segmentIndex, holdAfterActionSeconds);
    }
  }

  return roundSeconds(
    segments.reduce((total, segment) => {
      if (!isRecord(segment)) {
        return total;
      }

      const sourceStart = segment.sourceStart;
      const sourceEnd = segment.sourceEnd;
      const segmentIndex = segment.segmentIndex;

      if (typeof sourceStart !== "number" || typeof sourceEnd !== "number") {
        return total;
      }

      const holdAfterActionSeconds =
        typeof segmentIndex === "number"
          ? holdSecondsBySegmentIndex.get(segmentIndex) ?? 0
          : 0;

      return (
        total +
        Math.max(0, sourceEnd - sourceStart) +
        Math.max(0, holdAfterActionSeconds)
      );
    }, 0)
  );
}

function compactEditPlanForVoiceover(editPlan: EditPlanArtifact) {
  return {
    tutorialGoal: editPlan.tutorialGoal,
    tutorialSteps: editPlan.tutorialSteps,
    segments: editPlan.segments,
    warnings: editPlan.warnings,
  };
}

function buildVoiceoverScriptInstructions(options: {
  prompt: string;
  targetLanguage: string;
  selectedDurationSeconds: number;
  transcript: AssemblyAiTranscriptResponse;
  visualTimeline: VisualTimelineArtifact;
  editPlan: EditPlanArtifact;
  brandLanguageContext: BrandLanguageContext;
}) {
  return [
    "Write the final voiceover narration for a tutorial video edit.",
    "Return JSON only, following the required schema. Do not return markdown.",
    "The script field must contain plain narration only.",
    "Do not include speaker labels, timestamps, stage directions, markdown, bullet lists, or JSON inside the script field.",
    "Do not use phonetic replacements in visible script text.",
    "Brand terms must remain visible as real terms, for example Vidocu, not vee-doh-cuh.",
    "Glossary rules control visible text. Pronunciation dictionaries control speech only.",
    "",
    `User prompt: ${options.prompt}`,
    `Target language: ${options.targetLanguage}`,
    `Selected visual duration: ${options.selectedDurationSeconds}s`,
    "",
    "Write narration that fits the selected visual duration at a natural speaking pace.",
    "Use the selected segments as the source of truth for what the final viewer will see.",
    "Preserve tutorial logic and explain the selected actions clearly.",
    "",
    "Brand-language glossary rules for visible text:",
    JSON.stringify(options.brandLanguageContext.glossaryRules, null, 2),
    "",
    "Transcript context:",
    JSON.stringify(compactTranscriptForEditPlan(options.transcript), null, 2),
    "",
    "Visual timeline context:",
    JSON.stringify(
      compactVisualTimelineForEditPlan(options.visualTimeline),
      null,
      2
    ),
    "",
    "Selected edit plan:",
    JSON.stringify(compactEditPlanForVoiceover(options.editPlan), null, 2),
  ].join("\n");
}

function throwVoiceoverScriptValidationError(
  message: string,
  providerRequestId: string | null
): never {
  throw new WorkerError(message, {
    code: "openai_voiceover_script_validation_failed",
    provider: OPENAI_PROVIDER,
    providerRequestId,
    retryable: true,
  });
}

function normalizeLanguage(value: string) {
  return value.trim().toLowerCase();
}

function isObviousMarkdownOrStructuredText(script: string) {
  const trimmed = script.trim();

  return (
    trimmed.startsWith("```") ||
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
    /^#{1,6}\s+/m.test(trimmed) ||
    /^\s*[-*]\s+/m.test(trimmed) ||
    /^\s*\d+\.\s+/m.test(trimmed) ||
    /\*\*[^*]+\*\*/.test(trimmed)
  );
}

function hasSpeakerLabelsOrTiming(script: string) {
  return (
    /^\s*(?:narrator|voiceover|vo|speaker(?:\s+\d+)?)\s*:/im.test(script) ||
    /\b\d{1,2}:\d{2}(?::\d{2})?\b/.test(script) ||
    /\[\s*\d+(?:\.\d+)?\s*s?\s*\]/i.test(script)
  );
}

function hasStageDirections(script: string) {
  return /(?:\[(?:pause|music|cut|show|scene|fade)[^\]]*\]|\((?:pause|music|cut|show|scene|fade)[^)]*\))/i.test(
    script
  );
}

function validateVoiceoverScript(
  value: Record<string, unknown>,
  requestedTargetLanguage: string,
  providerRequestId: string | null
): {
  script: string;
  targetLanguage: string;
  selectedDurationSeconds: number;
  estimatedSpeakingSeconds: number;
  warnings: string[];
} {
  const script = value.script;
  const targetLanguage = value.targetLanguage;
  const selectedDurationSeconds = value.selectedDurationSeconds;
  const estimatedSpeakingSeconds = value.estimatedSpeakingSeconds;
  const warnings = value.warnings;

  if (typeof script !== "string" || !script.trim()) {
    throwVoiceoverScriptValidationError(
      "OpenAI voiceover script must contain a non-empty script",
      providerRequestId
    );
  }

  const trimmedScript = script.trim();

  if (
    isObviousMarkdownOrStructuredText(trimmedScript) ||
    hasSpeakerLabelsOrTiming(trimmedScript) ||
    hasStageDirections(trimmedScript)
  ) {
    throwVoiceoverScriptValidationError(
      "OpenAI voiceover script contained markdown, labels, timing, or stage directions",
      providerRequestId
    );
  }

  if (
    typeof targetLanguage !== "string" ||
    normalizeLanguage(targetLanguage) !== normalizeLanguage(requestedTargetLanguage)
  ) {
    throwVoiceoverScriptValidationError(
      "OpenAI voiceover script targetLanguage did not match the requested target language",
      providerRequestId
    );
  }

  if (
    typeof selectedDurationSeconds !== "number" ||
    !Number.isFinite(selectedDurationSeconds) ||
    selectedDurationSeconds <= 0
  ) {
    throwVoiceoverScriptValidationError(
      "OpenAI voiceover script selectedDurationSeconds was invalid",
      providerRequestId
    );
  }

  if (
    typeof estimatedSpeakingSeconds !== "number" ||
    !Number.isFinite(estimatedSpeakingSeconds) ||
    estimatedSpeakingSeconds <= 0
  ) {
    throwVoiceoverScriptValidationError(
      "OpenAI voiceover script estimatedSpeakingSeconds was invalid",
      providerRequestId
    );
  }

  if (!Array.isArray(warnings) || warnings.some((item) => typeof item !== "string")) {
    throwVoiceoverScriptValidationError(
      "OpenAI voiceover script warnings must be an array of strings",
      providerRequestId
    );
  }

  return {
    script: trimmedScript,
    targetLanguage,
    selectedDurationSeconds,
    estimatedSpeakingSeconds,
    warnings,
  };
}

async function generateVoiceoverScript(options: {
  videoId: string;
  sourceR2Key: string;
  transcriptR2Key: string;
  visualTimelineR2Key: string;
  editPlanR2Key: string;
  voiceoverR2Key: string;
  subtitleR2Key: string;
  prompt: string;
  targetLanguage: string;
  transcript: AssemblyAiTranscriptResponse;
  visualTimeline: VisualTimelineArtifact;
  editPlan: EditPlanArtifact;
  brandLanguageContext: BrandLanguageContext;
}) {
  const { apiKey, baseUrl, model, reasoningEffort, maxOutputTokens } =
    getOpenAiConfig();
  const selectedDurationSeconds = getSelectedDurationSeconds(options.editPlan);
  const response = await fetchOpenAi(
    `${baseUrl}/responses`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        reasoning: { effort: reasoningEffort },
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: buildVoiceoverScriptInstructions({
                  prompt: options.prompt,
                  targetLanguage: options.targetLanguage,
                  selectedDurationSeconds,
                  transcript: options.transcript,
                  visualTimeline: options.visualTimeline,
                  editPlan: options.editPlan,
                  brandLanguageContext: options.brandLanguageContext,
                }),
              },
            ],
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "voiceover_script",
            strict: true,
            schema: VOICEOVER_SCRIPT_SCHEMA,
          },
        },
        max_output_tokens: maxOutputTokens.voiceoverScript,
        store: false,
      }),
    },
    {
      code: "openai_voiceover_script_failed",
      failureMessage:
        "OpenAI voiceover script generation request failed after retries",
    }
  );

  const body = (await readJsonResponse(response)) as OpenAiResponsesResponse;
  const requestId = getProviderRequestId(response);

  if (!response.ok) {
    throw new WorkerError(
      getOpenAiErrorMessage(
        body,
        `OpenAI voiceover script generation failed with HTTP ${response.status}`
      ),
      {
        code: "openai_voiceover_script_failed",
        provider: OPENAI_PROVIDER,
        providerRequestId: requestId,
        retryable: response.status === 429 || response.status >= 500,
      }
    );
  }

  const outputText = body ? extractOpenAiOutputText(body) : null;
  const providerRequestId =
    typeof body?.id === "string" ? body.id : requestId ?? null;

  if (body && body.status === "incomplete") {
    throw new WorkerError(
      "OpenAI voiceover script generation response was incomplete before valid JSON was returned",
      {
        code: "openai_voiceover_script_incomplete",
        provider: OPENAI_PROVIDER,
        providerRequestId,
        retryable: true,
      }
    );
  }

  if (!outputText) {
    throw new WorkerError(
      "OpenAI voiceover script response had no output text",
      {
        code: "openai_voiceover_script_output_missing",
        provider: OPENAI_PROVIDER,
        providerRequestId,
        retryable: true,
      }
    );
  }

  let parsedOutput: Record<string, unknown>;

  try {
    parsedOutput = parseJsonObject(outputText);
  } catch (error) {
    throw new WorkerError(
      error instanceof Error
        ? error.message
        : "OpenAI voiceover script JSON was invalid",
      {
        code: "openai_voiceover_script_json_invalid",
        provider: OPENAI_PROVIDER,
        providerRequestId,
        retryable: true,
      }
    );
  }

  const validatedScript = validateVoiceoverScript(
    parsedOutput,
    options.targetLanguage,
    providerRequestId
  );

  return {
    videoId: options.videoId,
    sourceR2Key: options.sourceR2Key,
    transcriptR2Key: options.transcriptR2Key,
    visualTimelineR2Key: options.visualTimelineR2Key,
    editPlanR2Key: options.editPlanR2Key,
    voiceoverR2Key: options.voiceoverR2Key,
    subtitleR2Key: options.subtitleR2Key,
    provider: OPENAI_PROVIDER,
    providerRequestId,
    model,
    completedAt: new Date().toISOString(),
    prompt: options.prompt,
    targetLanguage: validatedScript.targetLanguage,
    script: validatedScript.script,
    selectedDurationSeconds: validatedScript.selectedDurationSeconds,
    requestedSelectedDurationSeconds: selectedDurationSeconds,
    estimatedSpeakingSeconds: validatedScript.estimatedSpeakingSeconds,
    warnings: validatedScript.warnings,
    brandLanguageContext: options.brandLanguageContext,
    rawResponse: body,
  };
}

async function generateOpenAiVoiceover(options: {
  script: string;
  outputPath: string;
}) {
  const {
    apiKey,
    baseUrl,
    model,
    voice,
    instructions,
    responseFormat,
  } = getOpenAiTtsConfig();
  const requestBody: Record<string, unknown> = {
    model,
    voice,
    input: options.script,
    response_format: responseFormat,
  };

  if (instructions) {
    requestBody.instructions = instructions;
  }

  const response = await fetchOpenAi(
    `${baseUrl}/audio/speech`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    },
    {
      code: "openai_tts_failed",
      failureMessage: "OpenAI voiceover generation request failed after retries",
    }
  );
  const requestId = getProviderRequestId(response);

  if (!response.ok) {
    const body = await readJsonResponse(response);

    throw new WorkerError(
      getOpenAiErrorMessage(
        body,
        `OpenAI voiceover generation failed with HTTP ${response.status}`
      ),
      {
        code: "openai_tts_failed",
        provider: OPENAI_PROVIDER,
        providerRequestId: requestId,
        retryable: response.status === 429 || response.status >= 500,
      }
    );
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer());

  if (audioBuffer.length === 0) {
    throw new WorkerError("OpenAI produced an empty voiceover audio file", {
      code: "openai_tts_audio_empty",
      provider: OPENAI_PROVIDER,
      providerRequestId: requestId,
      retryable: true,
    });
  }

  await writeFile(options.outputPath, audioBuffer);

  return {
    provider: OPENAI_PROVIDER,
    providerRequestId: requestId,
    model,
    voice,
    outputFormat: responseFormat,
    instructionsApplied: Boolean(instructions),
  };
}

function formatFfmpegSeconds(value: number) {
  return value.toFixed(3);
}

function getRenderSegments(
  editPlan: EditPlanArtifact,
  overlayRenderPlan?: InstructionOverlayRenderPlan | null
): RenderSegment[] {
  const segments = editPlan.segments;

  if (!Array.isArray(segments) || segments.length === 0) {
    throw new WorkerError("Edit plan does not contain renderable segments", {
      code: "edit_plan_render_segments_invalid",
      provider: OPENAI_PROVIDER,
      retryable: true,
    });
  }

  const overlayBySegmentIndex = new Map(
    overlayRenderPlan?.segments.map((segment) => [segment.segmentIndex, segment])
  );

  return segments.map((segment, index) => {
    if (!isRecord(segment)) {
      throw new WorkerError(`Edit plan segment ${index + 1} is invalid`, {
        code: "edit_plan_render_segments_invalid",
        provider: OPENAI_PROVIDER,
        retryable: true,
      });
    }

    const sourceStart = segment.sourceStart;
    const sourceEnd = segment.sourceEnd;
    const segmentIndex =
      typeof segment.segmentIndex === "number" &&
      Number.isInteger(segment.segmentIndex)
        ? segment.segmentIndex
        : index + 1;

    if (
      typeof sourceStart !== "number" ||
      typeof sourceEnd !== "number" ||
      !Number.isFinite(sourceStart) ||
      !Number.isFinite(sourceEnd) ||
      sourceEnd <= sourceStart
    ) {
      throw new WorkerError(
        `Edit plan segment ${index + 1} has invalid render timestamps`,
        {
          code: "edit_plan_render_segments_invalid",
          provider: OPENAI_PROVIDER,
          retryable: true,
        }
      );
    }

    const overlaySegment = overlayBySegmentIndex.get(segmentIndex);
    const sourceDurationSeconds = sourceEnd - sourceStart;
    const holdAfterActionSeconds =
      overlaySegment?.holdAfterActionSeconds ?? 0;

    return {
      index: segmentIndex,
      sourceStart,
      sourceEnd,
      sourceDurationSeconds,
      durationSeconds: sourceDurationSeconds + holdAfterActionSeconds,
      holdAfterActionSeconds,
      optionalCrop: overlaySegment?.optionalCrop ?? null,
    };
  });
}

function buildOptionalCropFilters(
  optionalCrop: RenderSegment["optionalCrop"],
  renderDimensions: RenderDimensions
) {
  if (!optionalCrop || optionalCrop.type !== "subtle_zoom") {
    return [];
  }

  const dimensions = renderDimensions;
  const scale = optionalCrop.scale.toFixed(4);
  const xBias = (0.5 + optionalCrop.xPercent / 200).toFixed(4);
  const yBias = (0.5 + optionalCrop.yPercent / 200).toFixed(4);

  return [
    `scale=ceil(iw*${scale}/2)*2:ceil(ih*${scale}/2)*2`,
    `crop=${dimensions.width}:${dimensions.height}:(iw-${dimensions.width})*${xBias}:(ih-${dimensions.height})*${yBias}`,
  ];
}

async function assertNonEmptyFile(filePath: string, options: {
  code: string;
  message: string;
}) {
  const fileStats = await stat(filePath);

  if (fileStats.size <= 0) {
    throw new WorkerError(options.message, {
      code: options.code,
      provider: "ffmpeg",
      retryable: true,
    });
  }

  return fileStats;
}

async function countMediaStreams(
  filePath: string,
  streamType: "a" | "v" | "s"
) {
  const { stdout } = await runCommand("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    streamType,
    "-show_entries",
    "stream=index",
    "-of",
    "csv=p=0",
    filePath,
  ]);
  const trimmedOutput = stdout.trim();

  return trimmedOutput ? trimmedOutput.split(/\r?\n/).length : 0;
}

async function hasFfmpegFilter(filterName: string) {
  try {
    const { stdout, stderr } = await runCommand("ffmpeg", [
      "-hide_banner",
      "-h",
      `filter=${filterName}`,
    ]);
    const output = `${stdout}\n${stderr}`;

    return !output.includes(`Unknown filter '${filterName}'`);
  } catch {
    return false;
  }
}

async function renderMutedClipEdit(options: {
  inputPath: string;
  outputPath: string;
  editPlan: EditPlanArtifact;
  workDir: string;
  renderDimensions: RenderDimensions;
  overlayRenderPlan?: InstructionOverlayRenderPlan | null;
}) {
  const segments = getRenderSegments(
    options.editPlan,
    options.overlayRenderPlan
  );
  const segmentFilters = segments.map((segment, index) => {
    const label = `v${index}`;

    const filters = [
      `[0:v]trim=start=${formatFfmpegSeconds(
        segment.sourceStart
      )}:end=${formatFfmpegSeconds(segment.sourceEnd)}`,
      "setpts=PTS-STARTPTS",
      ...buildClipScalePadFilters(options.renderDimensions),
      ...buildOptionalCropFilters(segment.optionalCrop, options.renderDimensions),
      segment.holdAfterActionSeconds > 0
        ? `tpad=stop_mode=clone:stop_duration=${formatFfmpegSeconds(
            segment.holdAfterActionSeconds
          )}`
        : null,
      "format=yuv420p",
    ].filter((filter): filter is string => Boolean(filter));

    return `${filters.join(",")}[${label}]`;
  });
  const filterParts = [...segmentFilters];
  const outputLabel = segments.length === 1 ? "v0" : "vcat";

  if (segments.length > 1) {
    const concatInputs = segments
      .map((_segment, index) => `[v${index}]`)
      .join("");

    filterParts.push(
      `${concatInputs}concat=n=${segments.length}:v=1:a=0[${outputLabel}]`
    );
  }

  await runFfmpeg(
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      path.basename(options.inputPath),
      "-filter_complex",
      filterParts.join(";"),
      "-map",
      `[${outputLabel}]`,
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      FINAL_RENDER_PRESET,
      "-crf",
      FINAL_RENDER_CRF,
      "-movflags",
      "+faststart",
      path.basename(options.outputPath),
    ],
    { cwd: options.workDir }
  );

  await assertNonEmptyFile(options.outputPath, {
    code: "muted_clip_render_empty",
    message: "FFmpeg produced an empty muted clip edit",
  });

  const audioStreamCount = await countMediaStreams(options.outputPath, "a");

  if (audioStreamCount > 0) {
    throw new WorkerError("Muted clip edit unexpectedly contains audio", {
      code: "muted_clip_render_has_audio",
      provider: "ffmpeg",
      retryable: true,
    });
  }

  return {
    selectedDurationSeconds: roundSeconds(
      segments.reduce(
        (total, segment) => total + segment.durationSeconds,
        0
      )
    ),
    segmentCount: segments.length,
  };
}

function escapeFfmpegFilterOption(value: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/,/g, "\\,")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

function buildBurnedSubtitleFilter(options: {
  subtitlesPath: string;
  fontsDir?: string;
}) {
  const subtitleOptions = [
    `filename=${escapeFfmpegFilterOption(path.basename(options.subtitlesPath))}`,
    options.fontsDir
      ? `fontsdir=${escapeFfmpegFilterOption(options.fontsDir)}`
      : null,
  ].filter((option): option is string => Boolean(option));

  return `subtitles=${subtitleOptions.join(":")}`;
}

async function assertSubtitleFontsDir(fontsDir: string) {
  try {
    const fontDirStats = await stat(fontsDir);

    if (!fontDirStats.isDirectory()) {
      throw new Error("not a directory");
    }
  } catch {
    throw new WorkerError("Subtitle font directory is missing", {
      code: "subtitle_fonts_dir_missing",
      provider: "ffmpeg",
      retryable: false,
    });
  }
}

async function renderFinalVideo(options: {
  mutedClipEditPath: string;
  voiceoverPath: string;
  subtitlesPath: string;
  textOverlayPath?: string | null;
  outputPath: string;
  workDir: string;
  subtitleFontsDir?: string;
  requireBurnedSubtitles?: boolean;
}) {
  const textOverlayPath = options.textOverlayPath ?? options.subtitlesPath;
  const mutedDurationSeconds = await getMediaDurationSeconds(
    options.mutedClipEditPath,
    "ffprobe_muted_clip_duration_invalid",
    "Unable to read muted clip duration with ffprobe"
  );
  const voiceoverDurationSeconds = await getMediaDurationSeconds(
    options.voiceoverPath,
    "ffprobe_voiceover_duration_invalid",
    "Unable to read voiceover duration with ffprobe"
  );
  const padDurationSeconds = Math.max(
    0,
    voiceoverDurationSeconds - mutedDurationSeconds
  );
  const supportsBurnedSubtitles = await hasFfmpegFilter("subtitles");

  if (!supportsBurnedSubtitles && options.requireBurnedSubtitles) {
    throw new WorkerError(
      "FFmpeg subtitles filter is required for Chinese subtitles",
      {
        code: "ffmpeg_subtitles_filter_missing",
        provider: "ffmpeg",
        retryable: false,
      }
    );
  }

  if (supportsBurnedSubtitles && options.subtitleFontsDir) {
    await assertSubtitleFontsDir(options.subtitleFontsDir);
  }

  const videoFilters = [
    padDurationSeconds > 0
      ? `tpad=stop_mode=clone:stop_duration=${formatFfmpegSeconds(
          padDurationSeconds
        )}`
      : null,
    supportsBurnedSubtitles
      ? buildBurnedSubtitleFilter({
          subtitlesPath: textOverlayPath,
          fontsDir: options.subtitleFontsDir,
        })
      : null,
    "format=yuv420p",
  ].filter((filter): filter is string => Boolean(filter));
  const subtitleInputArgs = supportsBurnedSubtitles
    ? []
    : ["-i", path.basename(textOverlayPath)];
  const subtitleMapArgs = supportsBurnedSubtitles ? [] : ["-map", "2:0"];
  const subtitleCodecArgs = supportsBurnedSubtitles
    ? []
    : ["-c:s", "mov_text", "-disposition:s:0", "default"];

  await runFfmpeg(
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      path.basename(options.mutedClipEditPath),
      "-i",
      path.basename(options.voiceoverPath),
      ...subtitleInputArgs,
      "-filter_complex",
      `[0:v]${videoFilters.join(",")}[vout]`,
      "-map",
      "[vout]",
      "-map",
      "1:a:0",
      ...subtitleMapArgs,
      "-c:v",
      "libx264",
      "-preset",
      FINAL_RENDER_PRESET,
      "-crf",
      FINAL_RENDER_CRF,
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      ...subtitleCodecArgs,
      "-movflags",
      "+faststart",
      path.basename(options.outputPath),
    ],
    { cwd: options.workDir }
  );

  const fileStats = await assertNonEmptyFile(options.outputPath, {
    code: "final_render_empty",
    message: "FFmpeg produced an empty final video",
  });
  const videoStreamCount = await countMediaStreams(options.outputPath, "v");
  const audioStreamCount = await countMediaStreams(options.outputPath, "a");

  if (videoStreamCount === 0 || audioStreamCount === 0) {
    throw new WorkerError("Final video is missing video or audio streams", {
      code: "final_render_streams_missing",
      provider: "ffmpeg",
      retryable: true,
    });
  }

  if (!supportsBurnedSubtitles) {
    const subtitleStreamCount = await countMediaStreams(options.outputPath, "s");

    if (subtitleStreamCount === 0) {
      throw new WorkerError("Final video is missing subtitle stream", {
        code: "final_render_subtitle_stream_missing",
        provider: "ffmpeg",
        retryable: true,
      });
    }
  }

  const finalDurationSeconds = await getMediaDurationSeconds(
    options.outputPath,
    "ffprobe_final_duration_invalid",
    "Unable to read final video duration with ffprobe"
  );

  if (
    voiceoverDurationSeconds > mutedDurationSeconds &&
    finalDurationSeconds + 0.1 < voiceoverDurationSeconds
  ) {
    throw new WorkerError("Final video is shorter than the voiceover", {
      code: "final_render_voiceover_cut_off",
      provider: "ffmpeg",
      retryable: true,
    });
  }

  return {
    mutedDurationSeconds: roundSeconds(mutedDurationSeconds),
    voiceoverDurationSeconds: roundSeconds(voiceoverDurationSeconds),
    finalDurationSeconds: roundSeconds(finalDurationSeconds),
    padDurationSeconds: roundSeconds(padDurationSeconds),
    sizeBytes: fileStats.size,
  };
}

async function prepareMutedClipForFinalRenderer(options: {
  mutedClipEditPath: string;
  voiceoverPath: string;
  paddedMutedClipEditPath: string;
  workDir: string;
}) {
  const mutedDurationSeconds = await getMediaDurationSeconds(
    options.mutedClipEditPath,
    "ffprobe_muted_clip_duration_invalid",
    "Unable to read muted clip duration with ffprobe"
  );
  const voiceoverDurationSeconds = await getMediaDurationSeconds(
    options.voiceoverPath,
    "ffprobe_voiceover_duration_invalid",
    "Unable to read voiceover duration with ffprobe"
  );
  const padDurationSeconds = Math.max(
    0,
    voiceoverDurationSeconds - mutedDurationSeconds
  );

  if (padDurationSeconds <= 0.05) {
    return {
      videoPath: options.mutedClipEditPath,
      mutedDurationSeconds: roundSeconds(mutedDurationSeconds),
      voiceoverDurationSeconds: roundSeconds(voiceoverDurationSeconds),
      paddedDurationSeconds: roundSeconds(mutedDurationSeconds),
      padDurationSeconds: 0,
    };
  }

  await runFfmpeg(
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      path.basename(options.mutedClipEditPath),
      "-vf",
      `tpad=stop_mode=clone:stop_duration=${formatFfmpegSeconds(
        padDurationSeconds
      )},format=yuv420p`,
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      FINAL_RENDER_PRESET,
      "-crf",
      FINAL_RENDER_CRF,
      "-movflags",
      "+faststart",
      path.basename(options.paddedMutedClipEditPath),
    ],
    { cwd: options.workDir }
  );

  await assertNonEmptyFile(options.paddedMutedClipEditPath, {
    code: "muted_clip_padding_empty",
    message: "FFmpeg produced an empty padded muted clip edit",
  });

  const paddedDurationSeconds = await getMediaDurationSeconds(
    options.paddedMutedClipEditPath,
    "ffprobe_padded_muted_clip_duration_invalid",
    "Unable to read padded muted clip duration with ffprobe"
  );

  return {
    videoPath: options.paddedMutedClipEditPath,
    mutedDurationSeconds: roundSeconds(mutedDurationSeconds),
    voiceoverDurationSeconds: roundSeconds(voiceoverDurationSeconds),
    paddedDurationSeconds: roundSeconds(paddedDurationSeconds),
    padDurationSeconds: roundSeconds(padDurationSeconds),
  };
}

async function renderInstructionOverlayVideo(options: {
  mutedClipEditPath: string;
  voiceoverPath: string;
  outputPath: string;
  workDir: string;
  renderDimensions: RenderDimensions;
  overlayRenderPlan: InstructionOverlayRenderPlan;
  videoBitrate: string;
}) {
  const paddedMutedClipEditPath = path.join(
    options.workDir,
    "muted-edit-padded.mp4"
  );
  const preparedVideo = await prepareMutedClipForFinalRenderer({
    mutedClipEditPath: options.mutedClipEditPath,
    voiceoverPath: options.voiceoverPath,
    paddedMutedClipEditPath,
    workDir: options.workDir,
  });
  const durationSeconds = Math.max(
    preparedVideo.paddedDurationSeconds,
    preparedVideo.voiceoverDurationSeconds
  );
  const durationInFrames = Math.max(1, Math.ceil(durationSeconds * REMOTION_FPS));
  const entryPoint = path.join(process.cwd(), "src", "remotion", "index.ts");
  const [{ bundle }, { renderMedia, selectComposition }] = await Promise.all([
    import("@remotion/bundler"),
    import("@remotion/renderer"),
  ]);
  const serveUrl = await bundle({
    entryPoint,
  });
  const inputProps = {
    videoSrc: pathToFileURL(preparedVideo.videoPath).href,
    voiceoverSrc: pathToFileURL(options.voiceoverPath).href,
    width: options.renderDimensions.width,
    height: options.renderDimensions.height,
    fps: REMOTION_FPS,
    durationInFrames,
    overlayCues: options.overlayRenderPlan.cues,
  };
  const composition = await selectComposition({
    serveUrl,
    id: REMOTION_COMPOSITION_ID,
    inputProps,
    logLevel: "warn",
  });

  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    outputLocation: options.outputPath,
    inputProps,
    overwrite: true,
    pixelFormat: "yuv420p",
    audioBitrate: "192k",
    videoBitrate: options.videoBitrate,
    enforceAudioTrack: true,
    logLevel: "warn",
  });

  const fileStats = await assertNonEmptyFile(options.outputPath, {
    code: "remotion_final_render_empty",
    message: "Remotion produced an empty final video",
  });
  const videoStreamCount = await countMediaStreams(options.outputPath, "v");
  const audioStreamCount = await countMediaStreams(options.outputPath, "a");

  if (videoStreamCount === 0 || audioStreamCount === 0) {
    throw new WorkerError("Remotion final video is missing video or audio", {
      code: "remotion_final_render_streams_missing",
      provider: "remotion",
      retryable: true,
    });
  }

  const finalDurationSeconds = await getMediaDurationSeconds(
    options.outputPath,
    "ffprobe_remotion_final_duration_invalid",
    "Unable to read Remotion final video duration with ffprobe"
  );

  if (finalDurationSeconds + 0.1 < preparedVideo.voiceoverDurationSeconds) {
    throw new WorkerError("Remotion final video is shorter than the voiceover", {
      code: "remotion_final_render_voiceover_cut_off",
      provider: "remotion",
      retryable: true,
    });
  }

  return {
    renderer: "remotion",
    mutedDurationSeconds: preparedVideo.mutedDurationSeconds,
    voiceoverDurationSeconds: preparedVideo.voiceoverDurationSeconds,
    finalDurationSeconds: roundSeconds(finalDurationSeconds),
    padDurationSeconds: preparedVideo.padDurationSeconds,
    videoBitrate: options.videoBitrate,
    sizeBytes: fileStats.size,
  };
}

async function extractInstructionDocumentFrames(options: {
  videoId: string;
  inputPath: string;
  outputDir: string;
  document: InstructionDocument;
}) {
  await mkdir(options.outputDir, { recursive: true });

  const assets: InstructionFrameAsset[] = [];

  for (const step of options.document.steps) {
    const stepNumber = String(step.stepIndex).padStart(2, "0");
    const filename = `step-${stepNumber}.jpg`;
    const filePath = path.join(options.outputDir, filename);
    const r2Key = `artifacts/${options.videoId}/instruction-document/frames/${filename}`;

    await runFfmpeg([
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      step.keyFrame.timestampSeconds.toFixed(3),
      "-i",
      options.inputPath,
      "-frames:v",
      "1",
      "-vf",
      `scale=${INSTRUCTION_FRAME_WIDTH}:-2`,
      "-q:v",
      "2",
      filePath,
    ]);

    const fileStats = await assertNonEmptyFile(filePath, {
      code: "instruction_frame_empty",
      message: "FFmpeg produced an empty instruction key frame",
    });

    assets.push({
      stepIndex: step.stepIndex,
      filePath,
      r2Key,
      sizeBytes: fileStats.size,
      timestampSeconds: step.keyFrame.timestampSeconds,
    });
  }

  return assets;
}

function buildInstructionDocumentArtifact(options: {
  videoId: string;
  sourceR2Key: string;
  transcriptR2Key: string;
  visualTimelineR2Key: string;
  editPlanR2Key: string;
  document: InstructionDocument;
  frameAssets: InstructionFrameAsset[];
  providerRequestId: string | null;
  model: string;
  rawResponse: unknown;
  sourceDurationSeconds: number;
}): InstructionDocumentArtifact {
  const frameAssetByStepIndex = new Map(
    options.frameAssets.map((asset) => [asset.stepIndex, asset])
  );
  const steps: InstructionDocumentArtifactStep[] = options.document.steps.map(
    (step) => {
      const frameAsset = frameAssetByStepIndex.get(step.stepIndex);

      if (!frameAsset) {
        throw new WorkerError(
          `Instruction document step ${step.stepIndex} is missing an extracted frame`,
          {
            code: "instruction_document_frame_missing",
            provider: "ffmpeg",
            retryable: true,
          }
        );
      }

      return {
        ...step,
        keyFrame: {
          ...step.keyFrame,
          r2Key: frameAsset.r2Key,
          sizeBytes: frameAsset.sizeBytes,
        },
      };
    }
  );

  return {
    videoId: options.videoId,
    sourceR2Key: options.sourceR2Key,
    transcriptR2Key: options.transcriptR2Key,
    visualTimelineR2Key: options.visualTimelineR2Key,
    editPlanR2Key: options.editPlanR2Key,
    provider: OPENAI_PROVIDER,
    providerRequestId: options.providerRequestId,
    model: options.model,
    completedAt: new Date().toISOString(),
    sourceDurationSeconds: options.sourceDurationSeconds,
    title: options.document.title,
    overview: options.document.overview,
    safetyPrecautions: options.document.safetyPrecautions,
    requiredToolsAndComponents: options.document.requiredToolsAndComponents,
    finalInspectionChecklist: options.document.finalInspectionChecklist,
    maintenanceRecommendations: options.document.maintenanceRecommendations,
    targetLanguage: options.document.targetLanguage,
    steps,
    rawResponse: options.rawResponse,
  };
}

function toWorkerError(error: unknown) {
  if (error instanceof WorkerError) {
    return error;
  }

  if (error instanceof Error) {
    return new WorkerError(error.message, {
      code: "worker_error",
      retryable: true,
    });
  }

  return new WorkerError("Unknown processing error", {
    code: "worker_error",
    retryable: true,
  });
}

function toFinalRenderWorkerError(
  error: unknown,
  provider: "ffmpeg" | "remotion"
) {
  if (error instanceof WorkerError) {
    return error;
  }

  const message =
    error instanceof Error ? error.message : "Final video render failed";

  return new WorkerError(message, {
    code:
      provider === "remotion"
        ? "remotion_final_render_failed"
        : "ffmpeg_final_render_failed",
    provider,
    retryable: true,
  });
}

export async function runProcessVideo(payload: ProcessVideoPayload) {
  let stage: WorkerStage = "queued";
  let transcriptId: string | null = null;
  let twelveLabsAnalysisTaskId: string | null = null;
  let geminiVideoEventResponseId: string | null = null;
  let openAiVisualResponseId: string | null = null;
  let openAiEditPlanResponseId: string | null = null;
  let openAiOverlayPlanResponseId: string | null = null;
  let openAiInstructionDocumentResponseId: string | null = null;
  let openAiScriptResponseId: string | null = null;
  let openAiTtsRequestId: string | null = null;
  let assemblyAiVoiceoverTranscriptId: string | null = null;
  const workDir = await mkdtemp(
    path.join(os.tmpdir(), `blooclip-${payload.videoId}-`)
  );
  const inputPath = path.join(workDir, "input.mp4");
  const audioPath = path.join(workDir, "audio.wav");
  const framesDir = path.join(workDir, "frames");
  const instructionFramesDir = path.join(workDir, "instruction-frames");
  const instructionPdfPath = path.join(workDir, "instruction-document.pdf");
  const voiceoverPath = path.join(workDir, "voiceover.mp3");
  const subtitlesPath = path.join(workDir, "subtitles.ass");
  const instructionOverlayPath = path.join(workDir, "instruction-overlays.ass");
  const mutedClipEditPath = path.join(workDir, "muted-edit.mp4");
  const finalPath = path.join(workDir, "final.mp4");
  const audioR2Key = `artifacts/${payload.videoId}/audio.wav`;
  const transcriptR2Key = `artifacts/${payload.videoId}/transcript.json`;
  const videoEventAnalysisR2Key = `artifacts/${payload.videoId}/video-event-analysis.json`;
  const visualTimelineR2Key = `artifacts/${payload.videoId}/visual-timeline.json`;
  const editPlanR2Key = `artifacts/${payload.videoId}/edit-plan.json`;
  const instructionPdfR2Key = `artifacts/${payload.videoId}/instruction-document/instructions.pdf`;
  const voiceoverScriptR2Key = `artifacts/${payload.videoId}/voiceover-script.json`;
  const voiceoverR2Key = `artifacts/${payload.videoId}/voiceover.mp3`;
  const subtitleR2Key = `artifacts/${payload.videoId}/subtitles.ass`;
  const finalR2Key = `videos/${payload.videoId}/final.mp4`;

  try {
    const video = await loadVideo(payload.videoId);
    const originalR2Key = video.original_r2_key;
    const prompt =
      typeof video.prompt === "string" && video.prompt.trim()
        ? video.prompt.trim()
        : "Create a key-event video with voiceover and subtitles";
    const targetLanguage =
      typeof video.target_language === "string" && video.target_language.trim()
        ? video.target_language.trim()
        : DEFAULT_TARGET_LANGUAGE;
    const videoAnalysisConfig = getVideoAnalysisConfig();
    const videoStyle = getVideoStyle();
    const renderer = getRenderer();
    const experimentalRemotionRendererEnabled =
      getExperimentalRemotionRendererEnabled();
    const outputVideoBitrate = getOutputVideoBitrate();
    const finalRenderer =
      videoStyle === "instruction_overlay" && experimentalRemotionRendererEnabled
        ? renderer
        : "ffmpeg";

    if (!originalR2Key) {
      throw new WorkerError("Video record is missing an original R2 key", {
        code: "original_r2_key_missing",
        provider: "supabase",
        retryable: false,
      });
    }

    await updateVideo(payload.videoId, {
      status: "processing",
      current_stage: "queued",
      progress: STAGE_PROGRESS.queued,
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
    });

    stage = "downloading_source";
    await updateStage(payload.videoId, stage);
    await downloadFromR2(originalR2Key, inputPath);
    const renderDimensions = await getSourceRenderDimensions(inputPath);
    const sourceDurationSeconds = roundSeconds(
      await getVideoDurationSeconds(inputPath)
    );

    stage = "extracting_audio";
    await updateStage(payload.videoId, stage);
    await runFfmpeg([
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      inputPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      audioPath,
    ]);
    await uploadFileToR2(audioR2Key, audioPath, "audio/wav");

    stage = "transcribing_audio";
    await updateStage(payload.videoId, stage);
    const assemblyAiAudioUrl = await uploadToAssemblyAi(audioPath);
    transcriptId = await submitAssemblyAiTranscript(assemblyAiAudioUrl);
    await updateVideo(payload.videoId, {
      provider_request_id: transcriptId,
      provider_run_ids: buildProviderRunIds({
        assemblyAiTranscriptId: transcriptId,
      }),
    });
    const transcript = await pollAssemblyAiTranscript(transcriptId);

    await uploadJsonToR2(transcriptR2Key, {
      videoId: payload.videoId,
      sourceR2Key: originalR2Key,
      audioR2Key,
      provider: ASSEMBLYAI_PROVIDER,
      providerRequestId: transcriptId,
      speechModels: ["universal-3-pro", "universal-2"],
      languageDetection: true,
      speakerLabels: true,
      completedAt: new Date().toISOString(),
      text: typeof transcript.text === "string" ? transcript.text : "",
      languageCode:
        typeof transcript.language_code === "string"
          ? transcript.language_code
          : null,
      languageConfidence:
        typeof transcript.language_confidence === "number"
          ? transcript.language_confidence
          : null,
      words: Array.isArray(transcript.words) ? transcript.words : [],
      utterances: Array.isArray(transcript.utterances)
        ? transcript.utterances
        : [],
      raw: transcript,
    });

    stage = "transcript_ready";
    await updateVideo(payload.videoId, {
      status: "processing",
      current_stage: stage,
      progress: STAGE_PROGRESS[stage],
      transcript_r2_key: transcriptR2Key,
      provider_request_id: transcriptId,
      provider_run_ids: buildProviderRunIds({
        assemblyAiTranscriptId: transcriptId,
      }),
      error_message: null,
      error_code: null,
      error_provider: null,
      retryable: null,
    });

    let videoEventAnalysis: VideoEventAnalysisArtifact | null = null;

    if (videoAnalysisConfig.provider !== "openai") {
      stage = "analyzing_video_events";
      await updateStage(payload.videoId, stage);

      try {
        if (videoAnalysisConfig.provider === "twelvelabs") {
          videoEventAnalysis = await analyzeVideoEventsWithTwelveLabs({
            videoId: payload.videoId,
            sourceR2Key: originalR2Key,
            transcriptR2Key,
            prompt,
            targetLanguage,
            durationSeconds: sourceDurationSeconds,
          });
          twelveLabsAnalysisTaskId =
            typeof videoEventAnalysis.providerRequestId === "string"
              ? videoEventAnalysis.providerRequestId
              : null;
        } else {
          videoEventAnalysis = await analyzeVideoEvents({
            videoId: payload.videoId,
            sourceR2Key: originalR2Key,
            transcriptR2Key,
            inputPath,
            originalContentType: getGeminiVideoContentType(
              video.original_content_type
            ),
            prompt,
            targetLanguage,
            transcript,
            durationSeconds: sourceDurationSeconds,
          });
          geminiVideoEventResponseId =
            typeof videoEventAnalysis.providerRequestId === "string"
              ? videoEventAnalysis.providerRequestId
              : null;
        }

        await uploadJsonToR2(videoEventAnalysisR2Key, videoEventAnalysis);

        stage = "video_event_analysis_ready";
        await updateVideo(payload.videoId, {
          status: "processing",
          current_stage: stage,
          progress: STAGE_PROGRESS[stage],
          transcript_r2_key: transcriptR2Key,
          video_event_analysis_r2_key: videoEventAnalysisR2Key,
          provider_request_id:
            twelveLabsAnalysisTaskId ??
            geminiVideoEventResponseId ??
            transcriptId,
          provider_run_ids: buildProviderRunIds({
            assemblyAiTranscriptId: transcriptId,
            twelveLabsAnalysisTaskId,
            geminiVideoEventResponseId,
          }),
          error_message: null,
          error_code: null,
          error_provider: null,
          retryable: null,
        });
      } catch (error) {
        const analysisError = toWorkerError(error);

        if (videoAnalysisConfig.required) {
          throw analysisError;
        }

        console.warn(
          `Skipping optional ${videoAnalysisConfig.provider} video event analysis for ${payload.videoId}: ${analysisError.message}`
        );
        videoEventAnalysis = null;
        twelveLabsAnalysisTaskId = null;
        geminiVideoEventResponseId = null;
      }
    }

    stage = "sampling_frames";
    await updateStage(payload.videoId, stage);
    const sampledFrameResult = await sampleFrames(
      payload.videoId,
      inputPath,
      framesDir,
      sourceDurationSeconds
    );

    stage = "analyzing_visuals";
    await updateStage(payload.videoId, stage);
    const visualTimeline = await analyzeVisualTimeline({
      videoId: payload.videoId,
      sourceR2Key: originalR2Key,
      transcriptR2Key,
      prompt,
      targetLanguage,
      transcript,
      sampledFrames: sampledFrameResult.frames,
      durationSeconds: sampledFrameResult.durationSeconds,
      intervalSeconds: sampledFrameResult.intervalSeconds,
      maxFrames: sampledFrameResult.maxFrames,
    });
    openAiVisualResponseId =
      typeof visualTimeline.providerRequestId === "string"
        ? visualTimeline.providerRequestId
        : null;
    await uploadJsonToR2(visualTimelineR2Key, visualTimeline);

    stage = "visual_analysis_ready";
    await updateVideo(payload.videoId, {
      status: "processing",
      current_stage: stage,
      progress: STAGE_PROGRESS[stage],
      transcript_r2_key: transcriptR2Key,
      video_event_analysis_r2_key: videoEventAnalysis
        ? videoEventAnalysisR2Key
        : null,
      visual_timeline_r2_key: visualTimelineR2Key,
      provider_request_id:
        openAiVisualResponseId ??
        twelveLabsAnalysisTaskId ??
        geminiVideoEventResponseId ??
        transcriptId,
      provider_run_ids: buildProviderRunIds({
        assemblyAiTranscriptId: transcriptId,
        twelveLabsAnalysisTaskId,
        geminiVideoEventResponseId,
        openAiVisualResponseId,
      }),
      error_message: null,
      error_code: null,
      error_provider: null,
      retryable: null,
    });

    stage = "planning_segments";
    await updateStage(payload.videoId, stage);
    let editPlan: EditPlanArtifact = await planTutorialSegments({
      videoId: payload.videoId,
      sourceR2Key: originalR2Key,
      transcriptR2Key,
      visualTimelineR2Key,
      videoEventAnalysisR2Key: videoEventAnalysis
        ? videoEventAnalysisR2Key
        : null,
      prompt,
      targetLanguage,
      transcript,
      visualTimeline,
      videoEventAnalysis,
      durationSeconds: sampledFrameResult.durationSeconds,
    });
    openAiEditPlanResponseId =
      typeof editPlan.providerRequestId === "string"
        ? editPlan.providerRequestId
        : null;
    let instructionOverlayPlan: InstructionOverlayPlan | null = null;
    let overlayRenderPlan: InstructionOverlayRenderPlan | null = null;

    if (videoStyle === "instruction_overlay") {
      const overlayPlanResult = await planInstructionOverlays({
        videoId: payload.videoId,
        sourceR2Key: originalR2Key,
        editPlanR2Key,
        prompt,
        targetLanguage,
        transcript,
        visualTimeline,
        videoEventAnalysis,
        editPlan,
      });
      openAiOverlayPlanResponseId =
        typeof overlayPlanResult.providerRequestId === "string"
          ? overlayPlanResult.providerRequestId
          : null;
      instructionOverlayPlan = overlayPlanResult.instructionOverlayPlan;
      overlayRenderPlan = buildInstructionOverlayRenderPlan({
        selectedSegments: getSelectedSegmentReferences(editPlan),
        overlayPlan: instructionOverlayPlan,
      });
      editPlan = {
        ...editPlan,
        instructionOverlayPlan,
        instructionOverlayProvider: {
          provider: overlayPlanResult.provider,
          providerRequestId: openAiOverlayPlanResponseId,
          model: overlayPlanResult.model,
          completedAt: overlayPlanResult.completedAt,
        },
        instructionOverlayRenderPlan: overlayRenderPlan,
      };
    }

    await uploadJsonToR2(editPlanR2Key, editPlan);

    stage = "edit_plan_ready";
    await updateVideo(payload.videoId, {
      status: "processing",
      current_stage: stage,
      progress: STAGE_PROGRESS[stage],
      transcript_r2_key: transcriptR2Key,
      video_event_analysis_r2_key: videoEventAnalysis
        ? videoEventAnalysisR2Key
        : null,
      visual_timeline_r2_key: visualTimelineR2Key,
      edit_plan_r2_key: editPlanR2Key,
      provider_request_id:
        openAiOverlayPlanResponseId ??
        openAiEditPlanResponseId ??
        openAiVisualResponseId ??
        twelveLabsAnalysisTaskId ??
        geminiVideoEventResponseId ??
        transcriptId,
      provider_run_ids: buildProviderRunIds({
        assemblyAiTranscriptId: transcriptId,
        twelveLabsAnalysisTaskId,
        geminiVideoEventResponseId,
        openAiVisualResponseId,
        openAiEditPlanResponseId,
        openAiOverlayPlanResponseId,
      }),
      error_message: null,
      error_code: null,
      error_provider: null,
      retryable: null,
    });

    stage = "writing_instruction_document";
    await updateStage(payload.videoId, stage);
    const instructionDocumentResult = await generateInstructionDocument({
      videoId: payload.videoId,
      sourceR2Key: originalR2Key,
      transcriptR2Key,
      visualTimelineR2Key,
      editPlanR2Key,
      prompt,
      targetLanguage,
      transcript,
      visualTimeline,
      editPlan,
      sampledFrames: sampledFrameResult.frames,
      durationSeconds: sampledFrameResult.durationSeconds,
    });
    openAiInstructionDocumentResponseId =
      instructionDocumentResult.providerRequestId;
    const instructionFrameAssets = await extractInstructionDocumentFrames({
      videoId: payload.videoId,
      inputPath,
      outputDir: instructionFramesDir,
      document: instructionDocumentResult.document,
    });
    const instructionDocumentArtifact = buildInstructionDocumentArtifact({
      videoId: payload.videoId,
      sourceR2Key: originalR2Key,
      transcriptR2Key,
      visualTimelineR2Key,
      editPlanR2Key,
      document: instructionDocumentResult.document,
      frameAssets: instructionFrameAssets,
      providerRequestId: openAiInstructionDocumentResponseId,
      model: instructionDocumentResult.model,
      rawResponse: instructionDocumentResult.rawResponse,
      sourceDurationSeconds: sampledFrameResult.durationSeconds,
    });
    await renderInstructionDocumentPdf({
      document: instructionDocumentArtifact,
      frameAssets: instructionFrameAssets,
      outputPath: instructionPdfPath,
    });

    await uploadFileToR2(
      instructionPdfR2Key,
      instructionPdfPath,
      "application/pdf"
    );

    stage = "instruction_document_ready";
    await updateVideo(payload.videoId, {
      status: "processing",
      current_stage: stage,
      progress: STAGE_PROGRESS[stage],
      transcript_r2_key: transcriptR2Key,
      video_event_analysis_r2_key: videoEventAnalysis
        ? videoEventAnalysisR2Key
        : null,
      visual_timeline_r2_key: visualTimelineR2Key,
      edit_plan_r2_key: editPlanR2Key,
      instruction_pdf_r2_key: instructionPdfR2Key,
      provider_request_id:
        openAiInstructionDocumentResponseId ??
        openAiOverlayPlanResponseId ??
        openAiEditPlanResponseId ??
        openAiVisualResponseId ??
        twelveLabsAnalysisTaskId ??
        geminiVideoEventResponseId ??
        transcriptId,
      provider_run_ids: buildProviderRunIds({
        assemblyAiTranscriptId: transcriptId,
        twelveLabsAnalysisTaskId,
        geminiVideoEventResponseId,
        openAiVisualResponseId,
        openAiEditPlanResponseId,
        openAiOverlayPlanResponseId,
        openAiInstructionDocumentResponseId,
      }),
      error_message: null,
      error_code: null,
      error_provider: null,
      retryable: null,
    });

    const brandLanguageContext = await resolveBrandLanguageContext(
      payload.videoId,
      targetLanguage
    );

    stage = "writing_script";
    await updateStage(payload.videoId, stage);
    const voiceoverScript = await generateVoiceoverScript({
      videoId: payload.videoId,
      sourceR2Key: originalR2Key,
      transcriptR2Key,
      visualTimelineR2Key,
      editPlanR2Key,
      voiceoverR2Key,
      subtitleR2Key,
      prompt,
      targetLanguage,
      transcript,
      visualTimeline,
      editPlan,
      brandLanguageContext,
    });
    openAiScriptResponseId =
      typeof voiceoverScript.providerRequestId === "string"
        ? voiceoverScript.providerRequestId
        : null;
    await uploadJsonToR2(voiceoverScriptR2Key, voiceoverScript);

    await updateVideo(payload.videoId, {
      status: "processing",
      current_stage: stage,
      progress: STAGE_PROGRESS[stage],
      transcript_r2_key: transcriptR2Key,
      video_event_analysis_r2_key: videoEventAnalysis
        ? videoEventAnalysisR2Key
        : null,
      visual_timeline_r2_key: visualTimelineR2Key,
      edit_plan_r2_key: editPlanR2Key,
      instruction_pdf_r2_key: instructionPdfR2Key,
      voiceover_script_r2_key: voiceoverScriptR2Key,
      provider_request_id:
        openAiScriptResponseId ??
        openAiInstructionDocumentResponseId ??
        openAiOverlayPlanResponseId ??
        openAiEditPlanResponseId ??
        openAiVisualResponseId ??
        twelveLabsAnalysisTaskId ??
        geminiVideoEventResponseId ??
        transcriptId,
      provider_run_ids: buildProviderRunIds({
        assemblyAiTranscriptId: transcriptId,
        twelveLabsAnalysisTaskId,
        geminiVideoEventResponseId,
        openAiVisualResponseId,
        openAiEditPlanResponseId,
        openAiOverlayPlanResponseId,
        openAiInstructionDocumentResponseId,
        openAiScriptResponseId,
      }),
      error_message: null,
      error_code: null,
      error_provider: null,
      retryable: null,
    });

    stage = "generating_voiceover";
    await updateStage(payload.videoId, stage);
    const voiceover = await generateOpenAiVoiceover({
      script: voiceoverScript.script,
      outputPath: voiceoverPath,
    });
    openAiTtsRequestId =
      typeof voiceover.providerRequestId === "string"
        ? voiceover.providerRequestId
        : null;
    await uploadFileToR2(voiceoverR2Key, voiceoverPath, "audio/mpeg");

    stage = "building_subtitles";
    await updateStage(payload.videoId, stage);
    const voiceoverAssemblyAiAudioUrl = await uploadToAssemblyAi(voiceoverPath);
    assemblyAiVoiceoverTranscriptId = await submitAssemblyAiTranscript(
      voiceoverAssemblyAiAudioUrl
    );
    await updateVideo(payload.videoId, {
      provider_request_id: assemblyAiVoiceoverTranscriptId ?? openAiTtsRequestId,
      provider_run_ids: buildProviderRunIds({
        assemblyAiTranscriptId: transcriptId,
        twelveLabsAnalysisTaskId,
        geminiVideoEventResponseId,
        openAiVisualResponseId,
        openAiEditPlanResponseId,
        openAiOverlayPlanResponseId,
        openAiInstructionDocumentResponseId,
        openAiScriptResponseId,
        openAiTtsRequestId,
        assemblyAiVoiceoverTranscriptId,
      }),
    });
    const voiceoverTranscript = await pollAssemblyAiTranscript(
      assemblyAiVoiceoverTranscriptId
    );
    const voiceoverDurationSeconds = await getMediaDurationSeconds(
      voiceoverPath,
      "ffprobe_voiceover_duration_invalid",
      "Unable to read voiceover duration with ffprobe"
    );
    const voiceoverAlignment = buildVoiceoverAlignmentFromTranscript({
      script: voiceoverScript.script,
      transcriptWords: voiceoverTranscript.words,
      durationSeconds: voiceoverDurationSeconds,
    });
    let subtitleCues: SubtitleCue[];

    try {
      subtitleCues = buildSubtitleCues(
        voiceoverScript.script,
        voiceoverAlignment.alignment,
        { targetLanguage }
      );
    } catch (error) {
      if (error instanceof SubtitleCueGenerationError) {
        throw new WorkerError(error.message, {
          code: error.code,
          retryable: true,
        });
      }

      throw error;
    }
    await writeFile(
      subtitlesPath,
      buildAssSubtitleFile(subtitleCues, renderDimensions),
      "utf8"
    );
    await uploadFileToR2(subtitleR2Key, subtitlesPath, "text/plain");

    if (overlayRenderPlan) {
      const instructionOverlayCues: InstructionOverlayCue[] =
        overlayRenderPlan.cues.map((cue) => ({
          startSeconds: cue.startSeconds,
          endSeconds: cue.endSeconds,
          text: cue.text,
        }));

      await writeFile(
        instructionOverlayPath,
        buildAssInstructionOverlayFile(
          instructionOverlayCues,
          renderDimensions
        ),
        "utf8"
      );
    }

    stage = "voiceover_subtitles_ready";
    await updateVideo(payload.videoId, {
      status: "processing",
      current_stage: stage,
      progress: STAGE_PROGRESS[stage],
      transcript_r2_key: transcriptR2Key,
      video_event_analysis_r2_key: videoEventAnalysis
        ? videoEventAnalysisR2Key
        : null,
      visual_timeline_r2_key: visualTimelineR2Key,
      edit_plan_r2_key: editPlanR2Key,
      instruction_pdf_r2_key: instructionPdfR2Key,
      voiceover_script_r2_key: voiceoverScriptR2Key,
      subtitle_r2_key: subtitleR2Key,
      provider_request_id:
        openAiTtsRequestId ??
        assemblyAiVoiceoverTranscriptId ??
        openAiScriptResponseId ??
        openAiInstructionDocumentResponseId ??
        openAiOverlayPlanResponseId ??
        openAiEditPlanResponseId ??
        openAiVisualResponseId ??
        twelveLabsAnalysisTaskId ??
        geminiVideoEventResponseId ??
        transcriptId,
      provider_run_ids: buildProviderRunIds({
        assemblyAiTranscriptId: transcriptId,
        twelveLabsAnalysisTaskId,
        geminiVideoEventResponseId,
        openAiVisualResponseId,
        openAiEditPlanResponseId,
        openAiOverlayPlanResponseId,
        openAiInstructionDocumentResponseId,
        openAiScriptResponseId,
        openAiTtsRequestId,
        assemblyAiVoiceoverTranscriptId,
      }),
      error_message: null,
      error_code: null,
      error_provider: null,
      retryable: null,
    });

    stage = "cutting_clips";
    await updateStage(payload.videoId, stage);
    await renderMutedClipEdit({
      inputPath,
      outputPath: mutedClipEditPath,
      editPlan,
      workDir,
      renderDimensions,
      overlayRenderPlan,
    });

    stage = "rendering_final";
    await updateStage(payload.videoId, stage);

    const finalRenderProvider =
      finalRenderer === "remotion" && overlayRenderPlan ? "remotion" : "ffmpeg";

    try {
      if (finalRenderProvider === "remotion" && overlayRenderPlan) {
        await renderInstructionOverlayVideo({
          mutedClipEditPath,
          voiceoverPath,
          outputPath: finalPath,
          workDir,
          renderDimensions,
          overlayRenderPlan,
          videoBitrate: outputVideoBitrate,
        });
      } else {
        await renderFinalVideo({
          mutedClipEditPath,
          voiceoverPath,
          subtitlesPath,
          textOverlayPath: overlayRenderPlan ? instructionOverlayPath : null,
          outputPath: finalPath,
          workDir,
          subtitleFontsDir: SUBTITLE_FONTS_DIR,
          requireBurnedSubtitles:
            Boolean(overlayRenderPlan) ||
            getTargetLanguageCode(targetLanguage) === "zh",
        });
      }
    } catch (error) {
      throw toFinalRenderWorkerError(error, finalRenderProvider);
    }

    stage = "uploading_final";
    await updateStage(payload.videoId, stage);
    await uploadFileToR2(finalR2Key, finalPath, "video/mp4");

    stage = "completed";
    await updateVideo(payload.videoId, {
      status: "completed",
      current_stage: stage,
      progress: STAGE_PROGRESS[stage],
      transcript_r2_key: transcriptR2Key,
      video_event_analysis_r2_key: videoEventAnalysis
        ? videoEventAnalysisR2Key
        : null,
      visual_timeline_r2_key: visualTimelineR2Key,
      edit_plan_r2_key: editPlanR2Key,
      instruction_pdf_r2_key: instructionPdfR2Key,
      voiceover_script_r2_key: voiceoverScriptR2Key,
      subtitle_r2_key: subtitleR2Key,
      final_r2_key: finalR2Key,
      provider_request_id:
        openAiTtsRequestId ??
        assemblyAiVoiceoverTranscriptId ??
        openAiScriptResponseId ??
        openAiInstructionDocumentResponseId ??
        openAiOverlayPlanResponseId ??
        openAiEditPlanResponseId ??
        openAiVisualResponseId ??
        twelveLabsAnalysisTaskId ??
        geminiVideoEventResponseId ??
        transcriptId,
      provider_run_ids: buildProviderRunIds({
        assemblyAiTranscriptId: transcriptId,
        twelveLabsAnalysisTaskId,
        geminiVideoEventResponseId,
        openAiVisualResponseId,
        openAiEditPlanResponseId,
        openAiOverlayPlanResponseId,
        openAiInstructionDocumentResponseId,
        openAiScriptResponseId,
        openAiTtsRequestId,
        assemblyAiVoiceoverTranscriptId,
      }),
      error_message: null,
      error_code: null,
      error_provider: null,
      retryable: null,
    });
  } catch (error) {
    const workerError = toWorkerError(error);
    await updateVideo(payload.videoId, {
      status: "failed",
      current_stage: stage,
      error_message: workerError.message,
      error_code: workerError.code,
      error_provider: workerError.provider,
      provider_request_id:
        workerError.providerRequestId ??
        assemblyAiVoiceoverTranscriptId ??
        openAiTtsRequestId ??
        openAiScriptResponseId ??
        openAiInstructionDocumentResponseId ??
        openAiOverlayPlanResponseId ??
        openAiEditPlanResponseId ??
        openAiVisualResponseId ??
        twelveLabsAnalysisTaskId ??
        geminiVideoEventResponseId ??
        transcriptId,
      retryable: workerError.retryable,
    });

    throw error;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export const processVideoTask = task({
  id: "process-video",
  machine: "large-2x",
  maxDuration: 60 * 30,
  run: async (payload: ProcessVideoPayload) => {
    await runProcessVideo(payload);
  },
});
