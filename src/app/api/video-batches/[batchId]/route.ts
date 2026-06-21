import { NextResponse } from "next/server";

import { AuthError } from "@/lib/auth";
import { loadAccessibleBatch } from "@/lib/ownership";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

type BatchContext = {
  params: Promise<{
    batchId: string;
  }>;
};

type BatchRow = {
  id: string;
  title: string;
  target_language: string;
  expected_video_count: number;
  created_at: string;
  updated_at: string;
  user_id: string | null;
};

type BatchVideoRow = {
  id: string;
  batch_position: number | null;
  original_filename: string | null;
  prompt: string | null;
  status: string;
  progress: number | null;
  current_stage: string | null;
  error_message: string | null;
  final_r2_key: string | null;
  instruction_doc_r2_key: string | null;
  instruction_pdf_r2_key: string | null;
  created_at: string;
  updated_at: string;
};

function errorResponse(error: string, status: number) {
  return NextResponse.json({ error }, { status });
}

export async function GET(_request: Request, context: BatchContext) {
  const { batchId } = await context.params;

  if (!batchId) {
    return errorResponse("Missing batchId", 400);
  }

  let batch: BatchRow;

  try {
    batch = await loadAccessibleBatch<BatchRow>(
      batchId,
      "id,title,target_language,expected_video_count,created_at,updated_at,user_id"
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return errorResponse(error.message, error.status);
    }

    const message =
      error instanceof Error ? error.message : "Failed to load video batch";

    return errorResponse(message, 500);
  }

  const { data: videosData, error: videosError } = await supabaseAdmin
    .from("videos")
    .select(
      "id,batch_position,original_filename,prompt,status,progress,current_stage,error_message,final_r2_key,instruction_doc_r2_key,instruction_pdf_r2_key,created_at,updated_at"
    )
    .eq("batch_id", batchId)
    .order("batch_position", { ascending: true })
    .order("created_at", { ascending: true });

  if (videosError) {
    return errorResponse(`Failed to load videos: ${videosError.message}`, 500);
  }

  const videos = (videosData ?? []) as BatchVideoRow[];

  return NextResponse.json({
    id: batch.id,
    title: batch.title,
    targetLanguage: batch.target_language,
    expectedVideoCount: batch.expected_video_count,
    createdAt: batch.created_at,
    updatedAt: batch.updated_at,
    videos: videos.map((video) => ({
      id: video.id,
      batchPosition: video.batch_position,
      filename: video.original_filename,
      prompt: video.prompt,
      status: video.status,
      progress: video.progress ?? 0,
      currentStage: video.current_stage,
      errorMessage: video.error_message,
      downloadReady: video.status === "completed" && Boolean(video.final_r2_key),
      instructionReady: Boolean(video.instruction_doc_r2_key),
      instructionPdfReady: Boolean(video.instruction_pdf_r2_key),
      createdAt: video.created_at,
      updatedAt: video.updated_at,
    })),
  });
}
