import { loadAccessibleBatch } from "./ownership.ts";
import { supabaseAdmin } from "./supabase-admin.ts";

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
  original_content_type: string | null;
  original_size_bytes: number | null;
  prompt: string | null;
  status: string;
  progress: number | null;
  current_stage: string | null;
  error_message: string | null;
  retryable: boolean | null;
  final_r2_key: string | null;
  instruction_pdf_r2_key: string | null;
  created_at: string;
  updated_at: string;
};

export async function loadAccessibleVideoBatchStatus(batchId: string) {
  const batch = await loadAccessibleBatch<BatchRow>(
    batchId,
    "id,title,target_language,expected_video_count,created_at,updated_at,user_id"
  );

  const { data: videosData, error: videosError } = await supabaseAdmin
    .from("videos")
    .select(
      "id,batch_position,original_filename,original_content_type,original_size_bytes,prompt,status,progress,current_stage,error_message,retryable,final_r2_key,instruction_pdf_r2_key,created_at,updated_at"
    )
    .eq("batch_id", batchId)
    .order("batch_position", { ascending: true })
    .order("created_at", { ascending: true });

  if (videosError) {
    throw new Error(`Failed to load videos: ${videosError.message}`);
  }

  const videos = (videosData ?? []) as BatchVideoRow[];

  return {
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
      contentType: video.original_content_type,
      size: video.original_size_bytes,
      prompt: video.prompt,
      status: video.status,
      progress: video.progress ?? 0,
      currentStage: video.current_stage,
      errorMessage: video.error_message,
      retryable: video.retryable === true,
      downloadReady: video.status === "completed" && Boolean(video.final_r2_key),
      instructionPdfReady: Boolean(video.instruction_pdf_r2_key),
      createdAt: video.created_at,
      updatedAt: video.updated_at,
    })),
  };
}
