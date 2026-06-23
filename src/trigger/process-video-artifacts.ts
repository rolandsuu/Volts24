export type ProcessVideoArtifactKeys = {
  audioR2Key: string;
  transcriptR2Key: string;
  videoEventAnalysisR2Key: string;
  visualTimelineR2Key: string;
  editPlanR2Key: string;
  instructionPdfR2Key: string;
  voiceoverScriptR2Key: string;
  voiceoverR2Key: string;
  subtitleR2Key: string;
  finalR2Key: string;
};

export function buildProcessVideoArtifactKeys(
  videoId: string
): ProcessVideoArtifactKeys {
  return {
    audioR2Key: `artifacts/${videoId}/audio.wav`,
    transcriptR2Key: `artifacts/${videoId}/transcript.json`,
    videoEventAnalysisR2Key: `artifacts/${videoId}/video-event-analysis.json`,
    visualTimelineR2Key: `artifacts/${videoId}/visual-timeline.json`,
    editPlanR2Key: `artifacts/${videoId}/edit-plan.json`,
    instructionPdfR2Key: `artifacts/${videoId}/instruction-document/instructions.pdf`,
    voiceoverScriptR2Key: `artifacts/${videoId}/voiceover-script.json`,
    voiceoverR2Key: `artifacts/${videoId}/voiceover.mp3`,
    subtitleR2Key: `artifacts/${videoId}/subtitles.ass`,
    finalR2Key: `videos/${videoId}/final.mp4`,
  };
}
