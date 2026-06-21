import { randomUUID } from "node:crypto";

import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { r2, R2_BUCKET_NAME } from "./r2.ts";
import { supabaseAdmin } from "./supabase-admin.ts";

export {
  DEFAULT_UPLOAD_PROMPT,
  MAX_BATCH_UPLOAD_FILES,
  getTrimmedString,
  normalizePrompt,
} from "./upload-settings.ts";

export const ACCEPTED_VIDEO_CONTENT_TYPES = new Set([
  "video/mp4",
  "video/webm",
  "video/quicktime",
]);

export type VideoUploadInput = {
  filename: string;
  contentType: string;
  size: number;
  prompt: string;
  targetLanguage: string;
  batchId?: string;
  batchPosition?: number;
};

export type VideoUploadRecord = {
  videoId: string;
  uploadUrl: string;
  filename: string;
  batchPosition: number | null;
};

export class UploadValidationError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "UploadValidationError";
    this.status = status;
  }
}

export function sanitizeFilename(filename: string) {
  const sanitized = filename.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return sanitized.slice(0, 120) || "video";
}

export function assertValidVideoUploadInput(input: VideoUploadInput) {
  if (!input.filename || !input.contentType || !input.targetLanguage) {
    throw new UploadValidationError(
      "Missing required fields: filename, contentType, and targetLanguage are required"
    );
  }

  if (!ACCEPTED_VIDEO_CONTENT_TYPES.has(input.contentType)) {
    throw new UploadValidationError("Unsupported video type");
  }

  if (
    !Number.isFinite(input.size) ||
    !Number.isInteger(input.size) ||
    input.size <= 0
  ) {
    throw new UploadValidationError("size must be a positive integer");
  }

  if (
    input.batchPosition !== undefined &&
    (!Number.isInteger(input.batchPosition) || input.batchPosition < 0)
  ) {
    throw new UploadValidationError(
      "batchPosition must be a non-negative integer"
    );
  }
}

export async function createSignedUploadUrl(
  r2Key: string,
  contentType: string
) {
  return getSignedUrl(
    r2,
    new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: r2Key,
      ContentType: contentType,
    }),
    { expiresIn: 60 * 10 }
  );
}

export async function createVideoUploadRecord(
  input: VideoUploadInput
): Promise<VideoUploadRecord> {
  assertValidVideoUploadInput(input);

  const videoId = randomUUID();
  const r2Key = `videos/${videoId}/${sanitizeFilename(input.filename)}`;
  const insertRecord: Record<string, unknown> = {
    id: videoId,
    original_filename: input.filename,
    original_r2_key: r2Key,
    original_content_type: input.contentType,
    original_size_bytes: input.size,
    prompt: input.prompt,
    target_language: input.targetLanguage,
    status: "created",
    progress: 0,
  };

  if (input.batchId) {
    insertRecord.batch_id = input.batchId;
  }

  if (input.batchPosition !== undefined) {
    insertRecord.batch_position = input.batchPosition;
  }

  const { error: insertError } = await supabaseAdmin
    .from("videos")
    .insert(insertRecord);

  if (insertError) {
    throw new Error(`Failed to create video record: ${insertError.message}`);
  }

  const uploadUrl = await createSignedUploadUrl(r2Key, input.contentType);

  return {
    videoId,
    uploadUrl,
    filename: input.filename,
    batchPosition: input.batchPosition ?? null,
  };
}
