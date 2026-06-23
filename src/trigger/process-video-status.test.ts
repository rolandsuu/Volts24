import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCompletedStageUpdate,
  buildFailureUpdate,
  buildInitialProcessingUpdate,
  buildProviderRunIds,
  buildSuccessfulStageUpdate,
} from "./process-video-status.ts";

test("buildProviderRunIds maps provider request ids to persisted keys", () => {
  assert.deepEqual(
    buildProviderRunIds({
      assemblyAiTranscriptId: "aa-source",
      openAiVisualResponseId: "openai-visual",
      openAiTtsRequestId: "openai-tts",
      assemblyAiVoiceoverTranscriptId: "aa-voiceover",
    }),
    {
      assemblyai_transcript_id: "aa-source",
      openai_visual_response_id: "openai-visual",
      openai_tts_request_id: "openai-tts",
      assemblyai_voiceover_transcript_id: "aa-voiceover",
    }
  );
});

test("buildSuccessfulStageUpdate preserves stage progress and clears prior errors", () => {
  assert.deepEqual(buildSuccessfulStageUpdate("writing_script"), {
    status: "processing",
    current_stage: "writing_script",
    progress: 72,
    error_message: null,
    error_code: null,
    error_provider: null,
    provider_request_id: null,
    retryable: null,
  });
});

test("buildInitialProcessingUpdate resets artifact keys before processing", () => {
  const update = buildInitialProcessingUpdate() as Record<string, unknown>;

  assert.equal(update.status, "processing");
  assert.equal(update.current_stage, "queued");
  assert.equal(update.progress, 5);
  assert.equal(update.transcript_r2_key, null);
  assert.equal(update.video_event_analysis_r2_key, null);
  assert.equal(update.visual_timeline_r2_key, null);
  assert.equal(update.edit_plan_r2_key, null);
  assert.equal(update.instruction_doc_r2_key, null);
  assert.equal(update.instruction_pdf_r2_key, null);
  assert.equal(update.voiceover_script_r2_key, null);
  assert.equal(update.subtitle_r2_key, null);
  assert.equal(update.final_r2_key, null);
  assert.deepEqual(update.provider_run_ids, {});
});

test("buildCompletedStageUpdate marks completed while preserving artifact fields", () => {
  assert.deepEqual(
    buildCompletedStageUpdate({
      final_r2_key: "videos/video-123/final.mp4",
    }),
    {
      status: "completed",
      current_stage: "completed",
      progress: 100,
      error_message: null,
      error_code: null,
      error_provider: null,
      retryable: null,
      final_r2_key: "videos/video-123/final.mp4",
    }
  );
});

test("buildFailureUpdate prefers provider request id from failure details", () => {
  assert.deepEqual(
    buildFailureUpdate(
      "rendering_final",
      {
        message: "render failed",
        code: "ffmpeg_final_render_failed",
        provider: "ffmpeg",
        providerRequestId: "failure-request",
        retryable: true,
      },
      "fallback-request"
    ),
    {
      status: "failed",
      current_stage: "rendering_final",
      error_message: "render failed",
      error_code: "ffmpeg_final_render_failed",
      error_provider: "ffmpeg",
      provider_request_id: "failure-request",
      retryable: true,
    }
  );
});
