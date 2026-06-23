export type WorkerStage =
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

export const STAGE_PROGRESS: Record<WorkerStage, number> = {
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
