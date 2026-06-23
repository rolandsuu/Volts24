import assert from "node:assert/strict";
import test from "node:test";

import { buildProcessVideoArtifactKeys } from "./process-video-artifacts.ts";

test("buildProcessVideoArtifactKeys keeps existing R2 paths", () => {
  assert.deepEqual(buildProcessVideoArtifactKeys("video-123"), {
    audioR2Key: "artifacts/video-123/audio.wav",
    transcriptR2Key: "artifacts/video-123/transcript.json",
    videoEventAnalysisR2Key:
      "artifacts/video-123/video-event-analysis.json",
    visualTimelineR2Key: "artifacts/video-123/visual-timeline.json",
    editPlanR2Key: "artifacts/video-123/edit-plan.json",
    instructionPdfR2Key:
      "artifacts/video-123/instruction-document/instructions.pdf",
    voiceoverScriptR2Key: "artifacts/video-123/voiceover-script.json",
    voiceoverR2Key: "artifacts/video-123/voiceover.mp3",
    subtitleR2Key: "artifacts/video-123/subtitles.ass",
    finalR2Key: "videos/video-123/final.mp4",
  });
});
