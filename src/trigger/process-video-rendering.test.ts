import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFinalVoiceoverSubtitleRenderOptions,
  DEFAULT_VIDEO_STYLE,
} from "./process-video-rendering.ts";

test("default video style still builds instruction overlays for edit decisions", () => {
  assert.equal(DEFAULT_VIDEO_STYLE, "instruction_overlay");
});

test("final render burns voiceover subtitles even when overlay captions exist", () => {
  const renderOptions = buildFinalVoiceoverSubtitleRenderOptions({
    subtitlesPath: "/tmp/work/subtitles.ass",
  });

  assert.deepEqual(renderOptions, {
    subtitlesPath: "/tmp/work/subtitles.ass",
    requireBurnedSubtitles: true,
  });
});
