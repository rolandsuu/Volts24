export type VideoStyle = "instruction_overlay" | "voiceover_subtitles";
export type FinalRenderer = "remotion" | "ffmpeg";

export const DEFAULT_VIDEO_STYLE: VideoStyle = "instruction_overlay";
export const DEFAULT_RENDERER: FinalRenderer = "ffmpeg";

export function selectFinalRenderProvider(options: {
  requestedRenderer: FinalRenderer;
  hasOverlayRenderPlan: boolean;
  voiceoverSubtitlesRequired: boolean;
}): FinalRenderer {
  if (
    options.requestedRenderer === "remotion" &&
    options.hasOverlayRenderPlan &&
    !options.voiceoverSubtitlesRequired
  ) {
    return "remotion";
  }

  return "ffmpeg";
}

export function buildFinalVoiceoverSubtitleRenderOptions(options: {
  subtitlesPath: string;
  instructionOverlayPath?: string | null;
  hasOverlayRenderPlan?: boolean;
}) {
  return {
    subtitlesPath: options.subtitlesPath,
    requireBurnedSubtitles: true,
  } as const;
}
