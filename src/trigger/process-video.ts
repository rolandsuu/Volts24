import { task } from "@trigger.dev/sdk/v3";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";

import { r2, R2_BUCKET_NAME } from "../lib/r2";
import { supabaseAdmin } from "../lib/supabase-admin";

type ProcessVideoPayload = {
  videoId: string;
  originalR2Key: string;
};

type VideoRow = {
  id: string;
  original_r2_key: string | null;
  prompt: string | null;
  target_language: string | null;
};

type WorkerStage =
  | "queued"
  | "downloading_source"
  | "extracting_audio"
  | "transcribing_audio"
  | "transcript_ready"
  | "sampling_frames"
  | "analyzing_visuals"
  | "visual_analysis_ready"
  | "planning_segments"
  | "edit_plan_ready"
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

const STAGE_PROGRESS: Record<WorkerStage, number> = {
  queued: 5,
  downloading_source: 8,
  extracting_audio: 12,
  transcribing_audio: 24,
  transcript_ready: 24,
  sampling_frames: 34,
  analyzing_visuals: 48,
  visual_analysis_ready: 48,
  planning_segments: 60,
  edit_plan_ready: 60,
  writing_script: 70,
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
const OPENAI_DEFAULT_MODEL = "gpt-5-mini";
const ELEVENLABS_PROVIDER = "elevenlabs";
const ELEVENLABS_DEFAULT_BASE_URL = "https://api.elevenlabs.io/v1";
const ELEVENLABS_DEFAULT_MODEL = "eleven_multilingual_v2";
const ELEVENLABS_DEFAULT_OUTPUT_FORMAT = "mp3_44100_128";
const DEFAULT_FRAME_SAMPLE_INTERVAL_SECONDS = 3;
const DEFAULT_MAX_VISUAL_FRAMES = 30;
const MAX_TRANSCRIPT_CONTEXT_CHARS = 6000;
const MAX_EDIT_PLAN_UTTERANCES = 80;
const MAX_EDIT_PLAN_WORDS = 300;
const MIN_EDIT_SEGMENT_DURATION_SECONDS = 0.25;
const MAX_SUBTITLE_CHARS = 44;
const MAX_SUBTITLE_DURATION_SECONDS = 4.5;
const MIN_SUBTITLE_DURATION_SECONDS = 0.35;
const FINAL_RENDER_WIDTH = 1080;
const FINAL_RENDER_HEIGHT = 1920;
const FINAL_RENDER_CRF = "23";
const FINAL_RENDER_PRESET = "veryfast";
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
    .select("id,original_r2_key,prompt,target_language")
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
    model: process.env.OPENAI_WORKER_MODEL ?? OPENAI_DEFAULT_MODEL,
  };
}

function getElevenLabsConfig() {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;

  if (!apiKey) {
    throw new WorkerError(
      "Missing ElevenLabs API key. Set ELEVENLABS_API_KEY.",
      {
        code: "elevenlabs_api_key_missing",
        provider: ELEVENLABS_PROVIDER,
        retryable: false,
      }
    );
  }

  if (!voiceId) {
    throw new WorkerError(
      "Missing ElevenLabs voice ID. Set ELEVENLABS_VOICE_ID.",
      {
        code: "elevenlabs_voice_id_missing",
        provider: ELEVENLABS_PROVIDER,
        retryable: false,
      }
    );
  }

  return {
    apiKey,
    voiceId,
    baseUrl: normalizeBaseUrl(
      process.env.ELEVENLABS_BASE_URL ?? ELEVENLABS_DEFAULT_BASE_URL
    ),
    modelId: process.env.ELEVENLABS_MODEL_ID ?? ELEVENLABS_DEFAULT_MODEL,
    outputFormat:
      process.env.ELEVENLABS_OUTPUT_FORMAT ??
      ELEVENLABS_DEFAULT_OUTPUT_FORMAT,
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
  framesDir: string
) {
  const { intervalSeconds, maxFrames } = getFrameSamplingConfig();
  const durationSeconds = await getVideoDurationSeconds(inputPath);
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

function getOpenAiErrorMessage(body: unknown, fallback: string) {
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

  if (typeof body === "string" && body.trim()) {
    return body;
  }

  return fallback;
}

function getElevenLabsErrorMessage(body: unknown, fallback: string) {
  if (body && typeof body === "object") {
    if ("detail" in body) {
      const detail = (body as { detail?: unknown }).detail;

      if (typeof detail === "string" && detail.trim()) {
        return detail;
      }

      if (Array.isArray(detail) && detail.length > 0) {
        return JSON.stringify(detail);
      }

      if (detail && typeof detail === "object") {
        const message = (detail as { message?: unknown }).message;

        if (typeof message === "string" && message.trim()) {
          return message;
        }

        return JSON.stringify(detail);
      }
    }

    if ("message" in body) {
      const message = (body as { message?: unknown }).message;

      if (typeof message === "string" && message.trim()) {
        return message;
      }
    }
  }

  if (typeof body === "string" && body.trim()) {
    return body;
  }

  return fallback;
}

function getRequestIdFromRecord(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }

  const requestId = value.request_id;

  return typeof requestId === "string" && requestId.trim()
    ? requestId
    : null;
}

function getElevenLabsProviderRequestId(response: Response, body: unknown) {
  if (isRecord(body)) {
    return (
      getProviderRequestId(response) ??
      getRequestIdFromRecord(body) ??
      getRequestIdFromRecord(body.detail)
    );
  }

  return getProviderRequestId(response);
}

function extractOpenAiOutputText(body: OpenAiResponsesResponse) {
  if (typeof body.output_text === "string" && body.output_text.trim()) {
    return body.output_text;
  }

  if (!Array.isArray(body.output)) {
    return null;
  }

  const textParts: string[] = [];

  for (const outputItem of body.output) {
    if (!outputItem || typeof outputItem !== "object") {
      continue;
    }

    const content = (outputItem as { content?: unknown }).content;

    if (!Array.isArray(content)) {
      continue;
    }

    for (const contentItem of content) {
      if (!contentItem || typeof contentItem !== "object") {
        continue;
      }

      const text = (contentItem as { text?: unknown }).text;

      if (typeof text === "string") {
        textParts.push(text);
      }
    }
  }

  return textParts.length > 0 ? textParts.join("\n") : null;
}

function parseJsonObject(text: string) {
  const trimmed = text.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  const parsed = JSON.parse(withoutFence) as unknown;

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("OpenAI response JSON was not an object");
  }

  return parsed as Record<string, unknown>;
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
  const { apiKey, baseUrl, model } = getOpenAiConfig();
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
      detail: "low",
    });
  }

  const response = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
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
      max_output_tokens: 5000,
      store: false,
    }),
  });

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

function buildEditPlanInstructions(options: {
  prompt: string;
  targetLanguage: string;
  transcript: AssemblyAiTranscriptResponse;
  visualTimeline: VisualTimelineArtifact;
  durationSeconds: number;
}) {
  return [
    "Create a tutorial-preserving edit plan for a video assembly pipeline.",
    "Return JSON only, following the required schema.",
    "This is not a generic highlight reel. Preserve tutorial logic and viewer understanding.",
    "You are receiving transcript timing and sampled-frame visual analysis, not raw video.",
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
    "10. Use transcript timing as semantic evidence and visual timeline frames/candidate moments as visual evidence.",
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
  prompt: string;
  targetLanguage: string;
  transcript: AssemblyAiTranscriptResponse;
  visualTimeline: VisualTimelineArtifact;
  durationSeconds: number;
}) {
  const { apiKey, baseUrl, model } = getOpenAiConfig();
  const response = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
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
      max_output_tokens: 5000,
      store: false,
    }),
  });

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

  const outputText = body ? extractOpenAiOutputText(body) : null;
  const providerRequestId =
    typeof body?.id === "string" ? body.id : requestId ?? null;

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

type ElevenLabsAlignment = {
  characters: string[];
  characterStartTimesSeconds: number[];
  characterEndTimesSeconds: number[];
};

type SubtitleWord = {
  text: string;
  startSeconds: number;
  endSeconds: number;
};

type SubtitleCue = {
  startSeconds: number;
  endSeconds: number;
  text: string;
};

type RenderSegment = {
  index: number;
  sourceStart: number;
  sourceEnd: number;
  durationSeconds: number;
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

  return roundSeconds(
    segments.reduce((total, segment) => {
      if (!isRecord(segment)) {
        return total;
      }

      const sourceStart = segment.sourceStart;
      const sourceEnd = segment.sourceEnd;

      if (typeof sourceStart !== "number" || typeof sourceEnd !== "number") {
        return total;
      }

      return total + Math.max(0, sourceEnd - sourceStart);
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
  const { apiKey, baseUrl, model } = getOpenAiConfig();
  const selectedDurationSeconds = getSelectedDurationSeconds(options.editPlan);
  const response = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
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
      max_output_tokens: 3000,
      store: false,
    }),
  });

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

function getIsoLanguageCode(targetLanguage: string) {
  const trimmed = targetLanguage.trim();

  return /^[a-z]{2}$/i.test(trimmed) ? trimmed.toLowerCase() : null;
}

function parseElevenLabsAlignment(value: unknown): ElevenLabsAlignment | null {
  if (!isRecord(value)) {
    return null;
  }

  const characters = value.characters;
  const starts = value.character_start_times_seconds;
  const ends = value.character_end_times_seconds;

  if (!Array.isArray(characters) || !Array.isArray(starts) || !Array.isArray(ends)) {
    return null;
  }

  if (
    characters.length === 0 ||
    characters.length !== starts.length ||
    characters.length !== ends.length
  ) {
    return null;
  }

  const parsedCharacters: string[] = [];
  const parsedStarts: number[] = [];
  const parsedEnds: number[] = [];
  let previousStart = -Infinity;
  let previousEnd = -Infinity;

  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    const start = starts[index];
    const end = ends[index];

    if (
      typeof character !== "string" ||
      typeof start !== "number" ||
      typeof end !== "number" ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end < start ||
      start < previousStart ||
      end < previousEnd
    ) {
      return null;
    }

    parsedCharacters.push(character);
    parsedStarts.push(start);
    parsedEnds.push(end);
    previousStart = start;
    previousEnd = end;
  }

  return {
    characters: parsedCharacters,
    characterStartTimesSeconds: parsedStarts,
    characterEndTimesSeconds: parsedEnds,
  };
}

function selectElevenLabsAlignment(
  body: Record<string, unknown>,
  script: string,
  providerRequestId: string | null
) {
  const scriptCharacters = Array.from(script);
  const candidates = [
    {
      alignment: parseElevenLabsAlignment(body.normalized_alignment),
      usedNormalizedAlignment: true,
    },
    {
      alignment: parseElevenLabsAlignment(body.alignment),
      usedNormalizedAlignment: false,
    },
  ];

  for (const candidate of candidates) {
    if (
      candidate.alignment &&
      candidate.alignment.characters.length === scriptCharacters.length
    ) {
      return candidate as {
        alignment: ElevenLabsAlignment;
        usedNormalizedAlignment: boolean;
      };
    }
  }

  throw new WorkerError(
    "ElevenLabs response did not include usable character timing alignment for the validated script",
    {
      code: "elevenlabs_alignment_invalid",
      provider: ELEVENLABS_PROVIDER,
      providerRequestId,
      retryable: true,
    }
  );
}

async function generateElevenLabsVoiceover(options: {
  script: string;
  targetLanguage: string;
  brandLanguageContext: BrandLanguageContext;
  outputPath: string;
}) {
  const { apiKey, voiceId, baseUrl, modelId, outputFormat } =
    getElevenLabsConfig();
  const url = new URL(
    `${baseUrl}/text-to-speech/${encodeURIComponent(
      voiceId
    )}/with-timestamps`
  );
  url.searchParams.set("output_format", outputFormat);

  const languageCode = getIsoLanguageCode(options.targetLanguage);
  const requestBody: Record<string, unknown> = {
    text: options.script,
    model_id: modelId,
  };

  if (languageCode) {
    requestBody.language_code = languageCode;
  }

  if (
    options.brandLanguageContext.pronunciationDictionaryLocators.length > 0
  ) {
    requestBody.pronunciation_dictionary_locators =
      options.brandLanguageContext.pronunciationDictionaryLocators;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": apiKey,
    },
    body: JSON.stringify(requestBody),
  });
  const body = (await readJsonResponse(response)) as unknown;
  const requestId = getElevenLabsProviderRequestId(response, body);

  if (!response.ok) {
    throw new WorkerError(
      getElevenLabsErrorMessage(
        body,
        `ElevenLabs voiceover generation failed with HTTP ${response.status}`
      ),
      {
        code: "elevenlabs_tts_failed",
        provider: ELEVENLABS_PROVIDER,
        providerRequestId: requestId,
        retryable: response.status === 429 || response.status >= 500,
      }
    );
  }

  if (!isRecord(body) || typeof body.audio_base64 !== "string") {
    throw new WorkerError("ElevenLabs response did not include audio_base64", {
      code: "elevenlabs_audio_missing",
      provider: ELEVENLABS_PROVIDER,
      providerRequestId: requestId,
      retryable: true,
    });
  }

  const audioBuffer = Buffer.from(body.audio_base64, "base64");

  if (audioBuffer.length === 0) {
    throw new WorkerError("ElevenLabs produced an empty voiceover audio file", {
      code: "elevenlabs_audio_empty",
      provider: ELEVENLABS_PROVIDER,
      providerRequestId: requestId,
      retryable: true,
    });
  }

  await writeFile(options.outputPath, audioBuffer);

  const providerRequestId = requestId;
  const { alignment, usedNormalizedAlignment } = selectElevenLabsAlignment(
    body,
    options.script,
    providerRequestId
  );

  return {
    provider: ELEVENLABS_PROVIDER,
    providerRequestId,
    modelId,
    outputFormat,
    languageCode,
    usedNormalizedAlignment,
    alignment,
  };
}

function buildSubtitleWords(
  script: string,
  alignment: ElevenLabsAlignment
): SubtitleWord[] {
  const scriptCharacters = Array.from(script);
  const words: SubtitleWord[] = [];
  let currentText = "";
  let currentStart: number | null = null;
  let currentEnd: number | null = null;

  function flushCurrentWord() {
    if (!currentText || currentStart === null || currentEnd === null) {
      return;
    }

    words.push({
      text: currentText,
      startSeconds: currentStart,
      endSeconds: currentEnd,
    });
    currentText = "";
    currentStart = null;
    currentEnd = null;
  }

  for (let index = 0; index < scriptCharacters.length; index += 1) {
    const character = scriptCharacters[index];
    const start = alignment.characterStartTimesSeconds[index];
    const end = alignment.characterEndTimesSeconds[index];

    if (/\s/.test(character)) {
      flushCurrentWord();
      continue;
    }

    if (currentStart === null) {
      currentStart = start;
    }

    currentText += character;
    currentEnd = end;
  }

  flushCurrentWord();

  if (words.length === 0) {
    throw new WorkerError("Unable to build subtitle words from voiceover script", {
      code: "subtitle_generation_failed",
      retryable: true,
    });
  }

  return words;
}

function createSubtitleCue(words: SubtitleWord[]): SubtitleCue {
  const startSeconds = words[0].startSeconds;
  const rawEndSeconds = words[words.length - 1].endSeconds;
  const endSeconds = Math.max(
    rawEndSeconds,
    startSeconds + MIN_SUBTITLE_DURATION_SECONDS
  );

  return {
    startSeconds,
    endSeconds,
    text: words.map((word) => word.text).join(" "),
  };
}

function buildSubtitleCues(
  script: string,
  alignment: ElevenLabsAlignment
): SubtitleCue[] {
  const words = buildSubtitleWords(script, alignment);
  const cues: SubtitleCue[] = [];
  let currentWords: SubtitleWord[] = [];

  function flushCurrentCue() {
    if (currentWords.length === 0) {
      return;
    }

    cues.push(createSubtitleCue(currentWords));
    currentWords = [];
  }

  for (const word of words) {
    if (currentWords.length > 0) {
      const candidateText = [...currentWords, word]
        .map((candidateWord) => candidateWord.text)
        .join(" ");
      const candidateDuration =
        word.endSeconds - currentWords[0].startSeconds;

      if (
        candidateText.length > MAX_SUBTITLE_CHARS ||
        candidateDuration > MAX_SUBTITLE_DURATION_SECONDS
      ) {
        flushCurrentCue();
      }
    }

    currentWords.push(word);

    const currentText = currentWords.map((currentWord) => currentWord.text).join(" ");

    if (/[.!?。！？]$/.test(word.text) && currentText.length >= 20) {
      flushCurrentCue();
    }
  }

  flushCurrentCue();

  return normalizeSubtitleCueTimings(cues);
}

function normalizeSubtitleCueTimings(cues: SubtitleCue[]) {
  let previousEnd = 0;

  return cues.map((cue, index) => {
    const nextStart = cues[index + 1]?.startSeconds;
    const startSeconds = Math.max(cue.startSeconds, previousEnd);
    let endSeconds = Math.max(
      cue.endSeconds,
      startSeconds + MIN_SUBTITLE_DURATION_SECONDS
    );

    if (typeof nextStart === "number" && endSeconds > nextStart) {
      endSeconds = Math.max(startSeconds + 0.05, nextStart);
    }

    previousEnd = endSeconds;

    return {
      ...cue,
      startSeconds,
      endSeconds,
    };
  });
}

function formatAssTimestamp(seconds: number) {
  const totalCentiseconds = Math.max(0, Math.round(seconds * 100));
  const hours = Math.floor(totalCentiseconds / 360000);
  const minutes = Math.floor((totalCentiseconds % 360000) / 6000);
  const wholeSeconds = Math.floor((totalCentiseconds % 6000) / 100);
  const centiseconds = totalCentiseconds % 100;

  return `${hours}:${String(minutes).padStart(2, "0")}:${String(
    wholeSeconds
  ).padStart(2, "0")}.${String(centiseconds).padStart(2, "0")}`;
}

function escapeAssText(text: string) {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/{/g, "\\{")
    .replace(/}/g, "\\}")
    .replace(/\r?\n/g, "\\N")
    .trim();
}

function buildAssSubtitleFile(cues: SubtitleCue[]) {
  const dialogueLines = cues.map(
    (cue) =>
      `Dialogue: 0,${formatAssTimestamp(cue.startSeconds)},${formatAssTimestamp(
        cue.endSeconds
      )},Default,,0,0,0,,${escapeAssText(cue.text)}`
  );

  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "PlayResX: 1080",
    "PlayResY: 1920",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Default,Arial,58,&H00FFFFFF,&H00FFFFFF,&H00111111,&H99000000,-1,0,0,0,100,100,0,0,1,4,1,2,80,80,120,1",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...dialogueLines,
    "",
  ].join("\n");
}

function formatFfmpegSeconds(value: number) {
  return value.toFixed(3);
}

function getRenderSegments(editPlan: EditPlanArtifact): RenderSegment[] {
  const segments = editPlan.segments;

  if (!Array.isArray(segments) || segments.length === 0) {
    throw new WorkerError("Edit plan does not contain renderable segments", {
      code: "edit_plan_render_segments_invalid",
      provider: OPENAI_PROVIDER,
      retryable: true,
    });
  }

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

    return {
      index: index + 1,
      sourceStart,
      sourceEnd,
      durationSeconds: sourceEnd - sourceStart,
    };
  });
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
  streamType: "a" | "v"
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

async function renderMutedClipEdit(options: {
  inputPath: string;
  outputPath: string;
  editPlan: EditPlanArtifact;
  workDir: string;
}) {
  const segments = getRenderSegments(options.editPlan);
  const segmentFilters = segments.map((segment, index) => {
    const label = `v${index}`;

    const filters = [
      `[0:v]trim=start=${formatFfmpegSeconds(
        segment.sourceStart
      )}:end=${formatFfmpegSeconds(segment.sourceEnd)}`,
      "setpts=PTS-STARTPTS",
      `scale=${FINAL_RENDER_WIDTH}:${FINAL_RENDER_HEIGHT}:force_original_aspect_ratio=decrease`,
      `pad=${FINAL_RENDER_WIDTH}:${FINAL_RENDER_HEIGHT}:(ow-iw)/2:(oh-ih)/2`,
      "setsar=1",
      "format=yuv420p",
    ];

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

async function renderFinalVideo(options: {
  mutedClipEditPath: string;
  voiceoverPath: string;
  subtitlesPath: string;
  outputPath: string;
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
  const videoFilters = [
    padDurationSeconds > 0
      ? `tpad=stop_mode=clone:stop_duration=${formatFfmpegSeconds(
          padDurationSeconds
        )}`
      : null,
    `subtitles=${path.basename(options.subtitlesPath)}`,
    "format=yuv420p",
  ].filter((filter): filter is string => Boolean(filter));

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
      "-filter_complex",
      `[0:v]${videoFilters.join(",")}[vout]`,
      "-map",
      "[vout]",
      "-map",
      "1:a:0",
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

export async function runProcessVideo(payload: ProcessVideoPayload) {
  let stage: WorkerStage = "queued";
  let transcriptId: string | null = null;
  let openAiVisualResponseId: string | null = null;
  let openAiEditPlanResponseId: string | null = null;
  let openAiScriptResponseId: string | null = null;
  let elevenLabsTtsRequestId: string | null = null;
  const workDir = await mkdtemp(
    path.join(os.tmpdir(), `blooclip-${payload.videoId}-`)
  );
  const inputPath = path.join(workDir, "input.mp4");
  const audioPath = path.join(workDir, "audio.wav");
  const framesDir = path.join(workDir, "frames");
  const voiceoverPath = path.join(workDir, "voiceover.mp3");
  const subtitlesPath = path.join(workDir, "subtitles.ass");
  const mutedClipEditPath = path.join(workDir, "muted-edit.mp4");
  const finalPath = path.join(workDir, "final.mp4");
  const audioR2Key = `artifacts/${payload.videoId}/audio.wav`;
  const transcriptR2Key = `artifacts/${payload.videoId}/transcript.json`;
  const visualTimelineR2Key = `artifacts/${payload.videoId}/visual-timeline.json`;
  const editPlanR2Key = `artifacts/${payload.videoId}/edit-plan.json`;
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
        : "en";

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
      visual_timeline_r2_key: null,
      edit_plan_r2_key: null,
      voiceover_script_r2_key: null,
      subtitle_r2_key: null,
      final_r2_key: null,
      provider_run_ids: {},
    });

    stage = "downloading_source";
    await updateStage(payload.videoId, stage);
    await downloadFromR2(originalR2Key, inputPath);

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
      provider_run_ids: {
        assemblyai_transcript_id: transcriptId,
      },
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
      provider_run_ids: {
        assemblyai_transcript_id: transcriptId,
      },
      error_message: null,
      error_code: null,
      error_provider: null,
      retryable: null,
    });

    stage = "sampling_frames";
    await updateStage(payload.videoId, stage);
    const sampledFrameResult = await sampleFrames(
      payload.videoId,
      inputPath,
      framesDir
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
      visual_timeline_r2_key: visualTimelineR2Key,
      provider_request_id: openAiVisualResponseId ?? transcriptId,
      provider_run_ids: {
        assemblyai_transcript_id: transcriptId,
        openai_visual_response_id: openAiVisualResponseId,
      },
      error_message: null,
      error_code: null,
      error_provider: null,
      retryable: null,
    });

    stage = "planning_segments";
    await updateStage(payload.videoId, stage);
    const editPlan = await planTutorialSegments({
      videoId: payload.videoId,
      sourceR2Key: originalR2Key,
      transcriptR2Key,
      visualTimelineR2Key,
      prompt,
      targetLanguage,
      transcript,
      visualTimeline,
      durationSeconds: sampledFrameResult.durationSeconds,
    });
    openAiEditPlanResponseId =
      typeof editPlan.providerRequestId === "string"
        ? editPlan.providerRequestId
        : null;
    await uploadJsonToR2(editPlanR2Key, editPlan);

    stage = "edit_plan_ready";
    await updateVideo(payload.videoId, {
      status: "processing",
      current_stage: stage,
      progress: STAGE_PROGRESS[stage],
      transcript_r2_key: transcriptR2Key,
      visual_timeline_r2_key: visualTimelineR2Key,
      edit_plan_r2_key: editPlanR2Key,
      provider_request_id:
        openAiEditPlanResponseId ?? openAiVisualResponseId ?? transcriptId,
      provider_run_ids: {
        assemblyai_transcript_id: transcriptId,
        openai_visual_response_id: openAiVisualResponseId,
        openai_edit_plan_response_id: openAiEditPlanResponseId,
      },
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
      visual_timeline_r2_key: visualTimelineR2Key,
      edit_plan_r2_key: editPlanR2Key,
      voiceover_script_r2_key: voiceoverScriptR2Key,
      provider_request_id:
        openAiScriptResponseId ??
        openAiEditPlanResponseId ??
        openAiVisualResponseId ??
        transcriptId,
      provider_run_ids: {
        assemblyai_transcript_id: transcriptId,
        openai_visual_response_id: openAiVisualResponseId,
        openai_edit_plan_response_id: openAiEditPlanResponseId,
        openai_script_response_id: openAiScriptResponseId,
      },
      error_message: null,
      error_code: null,
      error_provider: null,
      retryable: null,
    });

    stage = "generating_voiceover";
    await updateStage(payload.videoId, stage);
    const voiceover = await generateElevenLabsVoiceover({
      script: voiceoverScript.script,
      targetLanguage,
      brandLanguageContext,
      outputPath: voiceoverPath,
    });
    elevenLabsTtsRequestId =
      typeof voiceover.providerRequestId === "string"
        ? voiceover.providerRequestId
        : null;
    await uploadFileToR2(voiceoverR2Key, voiceoverPath, "audio/mpeg");

    stage = "building_subtitles";
    await updateStage(payload.videoId, stage);
    const subtitleCues = buildSubtitleCues(
      voiceoverScript.script,
      voiceover.alignment
    );
    await writeFile(subtitlesPath, buildAssSubtitleFile(subtitleCues), "utf8");
    await uploadFileToR2(subtitleR2Key, subtitlesPath, "text/plain");

    stage = "voiceover_subtitles_ready";
    await updateVideo(payload.videoId, {
      status: "processing",
      current_stage: stage,
      progress: STAGE_PROGRESS[stage],
      transcript_r2_key: transcriptR2Key,
      visual_timeline_r2_key: visualTimelineR2Key,
      edit_plan_r2_key: editPlanR2Key,
      voiceover_script_r2_key: voiceoverScriptR2Key,
      subtitle_r2_key: subtitleR2Key,
      provider_request_id:
        elevenLabsTtsRequestId ??
        openAiScriptResponseId ??
        openAiEditPlanResponseId ??
        openAiVisualResponseId ??
        transcriptId,
      provider_run_ids: {
        assemblyai_transcript_id: transcriptId,
        openai_visual_response_id: openAiVisualResponseId,
        openai_edit_plan_response_id: openAiEditPlanResponseId,
        openai_script_response_id: openAiScriptResponseId,
        elevenlabs_tts_request_id: elevenLabsTtsRequestId,
      },
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
    });

    stage = "rendering_final";
    await updateStage(payload.videoId, stage);
    await renderFinalVideo({
      mutedClipEditPath,
      voiceoverPath,
      subtitlesPath,
      outputPath: finalPath,
      workDir,
    });

    stage = "uploading_final";
    await updateStage(payload.videoId, stage);
    await uploadFileToR2(finalR2Key, finalPath, "video/mp4");

    stage = "completed";
    await updateVideo(payload.videoId, {
      status: "completed",
      current_stage: stage,
      progress: STAGE_PROGRESS[stage],
      transcript_r2_key: transcriptR2Key,
      visual_timeline_r2_key: visualTimelineR2Key,
      edit_plan_r2_key: editPlanR2Key,
      voiceover_script_r2_key: voiceoverScriptR2Key,
      subtitle_r2_key: subtitleR2Key,
      final_r2_key: finalR2Key,
      provider_request_id:
        elevenLabsTtsRequestId ??
        openAiScriptResponseId ??
        openAiEditPlanResponseId ??
        openAiVisualResponseId ??
        transcriptId,
      provider_run_ids: {
        assemblyai_transcript_id: transcriptId,
        openai_visual_response_id: openAiVisualResponseId,
        openai_edit_plan_response_id: openAiEditPlanResponseId,
        openai_script_response_id: openAiScriptResponseId,
        elevenlabs_tts_request_id: elevenLabsTtsRequestId,
      },
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
        elevenLabsTtsRequestId ??
        openAiScriptResponseId ??
        openAiEditPlanResponseId ??
        openAiVisualResponseId ??
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
  machine: "medium-1x",
  maxDuration: 60 * 30,
  run: async (payload: ProcessVideoPayload) => {
    await runProcessVideo(payload);
  },
});
