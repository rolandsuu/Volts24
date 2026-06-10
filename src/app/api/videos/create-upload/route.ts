import { randomUUID } from "node:crypto";

import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { NextResponse } from "next/server";

import { r2, R2_BUCKET_NAME } from "@/lib/r2";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

const ACCEPTED_CONTENT_TYPES = new Set([
  "video/mp4",
  "video/webm",
  "video/quicktime",
]);

const DEFAULT_UPLOAD_PROMPT =
  "Create a key-event video with voiceover and subtitles";

type CreateUploadBody = {
  filename?: unknown;
  contentType?: unknown;
  size?: unknown;
  prompt?: unknown;
  targetLanguage?: unknown;
};

function errorResponse(error: string, status: number) {
  return NextResponse.json({ error }, { status });
}

function getStringField(
  body: CreateUploadBody,
  key: keyof CreateUploadBody
) {
  const value = body[key];

  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }

  return value.trim();
}

function sanitizeFilename(filename: string) {
  const sanitized = filename.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return sanitized.slice(0, 120) || "video";
}

export async function POST(request: Request) {
  let body: CreateUploadBody;

  try {
    body = (await request.json()) as CreateUploadBody;
  } catch {
    return errorResponse("Request body must be valid JSON", 400);
  }

  const filename = getStringField(body, "filename");
  const contentType = getStringField(body, "contentType");
  const prompt = getStringField(body, "prompt") ?? DEFAULT_UPLOAD_PROMPT;
  const targetLanguage = getStringField(body, "targetLanguage");
  const size = body.size;

  if (!filename || !contentType || !targetLanguage) {
    return errorResponse(
      "Missing required fields: filename, contentType, and targetLanguage are required",
      400
    );
  }

  if (!ACCEPTED_CONTENT_TYPES.has(contentType)) {
    return errorResponse("Unsupported video type", 400);
  }

  if (
    typeof size !== "number" ||
    !Number.isFinite(size) ||
    !Number.isInteger(size) ||
    size <= 0
  ) {
    return errorResponse("size must be a positive integer", 400);
  }

  const videoId = randomUUID();
  const r2Key = `videos/${videoId}/${sanitizeFilename(filename)}`;

  const { error: insertError } = await supabaseAdmin.from("videos").insert({
    id: videoId,
    original_filename: filename,
    original_r2_key: r2Key,
    original_content_type: contentType,
    prompt,
    target_language: targetLanguage,
    status: "created",
    progress: 0,
  });

  if (insertError) {
    return errorResponse(
      `Failed to create video record: ${insertError.message}`,
      500
    );
  }

  try {
    const uploadUrl = await getSignedUrl(
      r2,
      new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: r2Key,
        ContentType: contentType,
      }),
      { expiresIn: 60 * 10 }
    );

    return NextResponse.json({ videoId, uploadUrl });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to create upload URL";

    return errorResponse(message, 500);
  }
}
