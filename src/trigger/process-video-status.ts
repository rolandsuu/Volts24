import { STAGE_PROGRESS, type WorkerStage } from "./process-video-stages.ts";

export type ProviderRunIdsInput = {
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
};

export type WorkerFailureDetails = {
  message: string;
  code: string;
  provider: string | null;
  providerRequestId: string | null;
  retryable: boolean;
};

export function buildProviderRunIds(ids: ProviderRunIdsInput) {
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

export function buildSuccessfulStageUpdate(
  stage: WorkerStage,
  values: Record<string, unknown> = {}
) {
  return {
    status: "processing",
    current_stage: stage,
    progress: STAGE_PROGRESS[stage],
    error_message: null,
    error_code: null,
    error_provider: null,
    provider_request_id: null,
    retryable: null,
    ...values,
  };
}

export function buildInitialProcessingUpdate() {
  return buildSuccessfulStageUpdate("queued", {
    provider_request_id: null,
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
}

export function buildCompletedStageUpdate(
  values: Record<string, unknown> = {}
) {
  return {
    status: "completed",
    current_stage: "completed",
    progress: STAGE_PROGRESS.completed,
    error_message: null,
    error_code: null,
    error_provider: null,
    retryable: null,
    ...values,
  };
}

export function buildFailureUpdate(
  stage: WorkerStage,
  failure: WorkerFailureDetails,
  providerRequestId: string | null
) {
  return {
    status: "failed",
    current_stage: stage,
    error_message: failure.message,
    error_code: failure.code,
    error_provider: failure.provider,
    provider_request_id: failure.providerRequestId ?? providerRequestId,
    retryable: failure.retryable,
  };
}
