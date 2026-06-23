import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFinalVoiceoverSubtitleRenderOptions,
  DEFAULT_VIDEO_STYLE,
  selectFinalRenderProvider,
} from "./process-video-rendering.ts";

test("default video style still builds instruction overlays for edit decisions", () => {
  assert.equal(DEFAULT_VIDEO_STYLE, "instruction_overlay");
});

test("voiceover subtitles route instruction-overlay jobs through ffmpeg", () => {
  assert.equal(
    selectFinalRenderProvider({
      requestedRenderer: "remotion",
      hasOverlayRenderPlan: true,
      voiceoverSubtitlesRequired: true,
    }),
    "ffmpeg"
  );
});

test("final render burns voiceover subtitles even when overlay captions exist", () => {
  const renderOptions = buildFinalVoiceoverSubtitleRenderOptions({
    subtitlesPath: "/tmp/work/subtitles.ass",
    instructionOverlayPath: "/tmp/work/instruction-overlays.ass",
    hasOverlayRenderPlan: true,
  });

  assert.deepEqual(renderOptions, {
    subtitlesPath: "/tmp/work/subtitles.ass",
    requireBurnedSubtitles: true,
  });
});
