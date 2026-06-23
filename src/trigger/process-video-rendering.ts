export type VideoStyle = "instruction_overlay" | "voiceover_subtitles";

export const DEFAULT_VIDEO_STYLE: VideoStyle = "instruction_overlay";

export function buildFinalVoiceoverSubtitleRenderOptions(options: {
  subtitlesPath: string;
}) {
  return {
    subtitlesPath: options.subtitlesPath,
    requireBurnedSubtitles: true,
  } as const;
}
