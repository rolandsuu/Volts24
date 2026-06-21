import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { NextResponse } from "next/server";

import type { InstructionDocumentArtifact } from "@/lib/instruction-document";
import { r2, R2_BUCKET_NAME } from "@/lib/r2";
import { AuthError } from "@/lib/auth";
import { loadAccessibleVideo } from "@/lib/ownership";

export const runtime = "nodejs";

type InstructionDocumentContext = {
  params: Promise<{
    videoId: string;
  }>;
};

type InstructionDocumentRow = {
  instruction_doc_r2_key: string | null;
  instruction_pdf_r2_key: string | null;
  user_id: string | null;
};

type TransformableBody = {
  transformToString?: () => Promise<string>;
} & AsyncIterable<Uint8Array>;

function errorResponse(error: string, status: number) {
  return NextResponse.json({ error }, { status });
}

async function streamToString(stream: AsyncIterable<Uint8Array>) {
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function readJsonFromR2(key: string) {
  const result = await r2.send(
    new GetObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
    })
  );

  if (!result.Body) {
    throw new Error("R2 object has no body");
  }

  const body = result.Body as TransformableBody;
  const text =
    typeof body.transformToString === "function"
      ? await body.transformToString()
      : await streamToString(body);

  return JSON.parse(text) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isInstructionDocumentArtifact(
  value: unknown
): value is InstructionDocumentArtifact {
  return (
    isRecord(value) &&
    typeof value.title === "string" &&
    typeof value.overview === "string" &&
    typeof value.targetLanguage === "string" &&
    Array.isArray(value.steps)
  );
}

async function signR2Object(key: string, filename?: string) {
  return getSignedUrl(
    r2,
    new GetObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
      ResponseContentDisposition: filename
        ? `attachment; filename="${filename}"`
        : undefined,
    }),
    { expiresIn: 60 * 10 }
  );
}

export async function GET(
  _request: Request,
  context: InstructionDocumentContext
) {
  const { videoId } = await context.params;

  if (!videoId) {
    return errorResponse("Missing videoId", 400);
  }

  let video: InstructionDocumentRow;

  try {
    video = await loadAccessibleVideo<InstructionDocumentRow>(
      videoId,
      "instruction_doc_r2_key,instruction_pdf_r2_key,user_id"
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return errorResponse(error.message, error.status);
    }

    const message =
      error instanceof Error ? error.message : "Failed to load video";

    return errorResponse(message, 500);
  }

  if (!video.instruction_doc_r2_key || !video.instruction_pdf_r2_key) {
    return errorResponse("Instruction document is not ready", 409);
  }

  try {
    const document = await readJsonFromR2(video.instruction_doc_r2_key);

    if (!isInstructionDocumentArtifact(document)) {
      return errorResponse("Instruction document artifact was invalid", 500);
    }

    const steps = await Promise.all(
      document.steps.map(async (step) => ({
        ...step,
        keyFrame: {
          ...step.keyFrame,
          url: await signR2Object(step.keyFrame.r2Key),
        },
      }))
    );
    const pdfDownloadUrl = await signR2Object(
      video.instruction_pdf_r2_key,
      `${videoId}-instructions.pdf`
    );

    return NextResponse.json({
      document: {
        title: document.title,
        overview: document.overview,
        targetLanguage: document.targetLanguage,
        warnings: document.warnings,
        completedAt: document.completedAt,
        sourceDurationSeconds: document.sourceDurationSeconds,
        steps,
      },
      pdfDownloadUrl,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to load instruction document";

    return errorResponse(message, 500);
  }
}
