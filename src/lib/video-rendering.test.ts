import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAssInstructionOverlayFile,
  buildAssSubtitleFile,
  buildClipScalePadFilters,
  DEFAULT_SUBTITLE_FONT_FAMILY,
  normalizeRenderDimensions,
  readRenderDimensionsFromFfprobe,
} from "./video-rendering.ts";

test("readRenderDimensionsFromFfprobe preserves landscape source size", () => {
  const dimensions = readRenderDimensionsFromFfprobe({
    streams: [
      {
        width: 1920,
        height: 1080,
        sample_aspect_ratio: "1:1",
        display_aspect_ratio: "16:9",
      },
    ],
  });

  assert.deepEqual(dimensions, { width: 1920, height: 1080 });
  assert.deepEqual(buildClipScalePadFilters(dimensions), [
    "scale=1920:1080:force_original_aspect_ratio=decrease",
    "pad=1920:1080:(ow-iw)/2:(oh-ih)/2",
    "setsar=1",
  ]);
});

test("readRenderDimensionsFromFfprobe preserves portrait source size", () => {
  const dimensions = readRenderDimensionsFromFfprobe({
    streams: [
      {
        width: 1080,
        height: 1920,
        sample_aspect_ratio: "1:1",
        display_aspect_ratio: "9:16",
      },
    ],
  });

  assert.deepEqual(dimensions, { width: 1080, height: 1920 });
  assert.deepEqual(buildClipScalePadFilters(dimensions), [
    "scale=1080:1920:force_original_aspect_ratio=decrease",
    "pad=1080:1920:(ow-iw)/2:(oh-ih)/2",
    "setsar=1",
  ]);
});

test("buildAssSubtitleFile uses render dimensions and scales style", () => {
  const subtitles = buildAssSubtitleFile(
    [
      {
        startSeconds: 0,
        endSeconds: 2.5,
        text: "Prepare the cup stack",
      },
    ],
    { width: 1920, height: 1080 }
  );

  assert.match(subtitles, /PlayResX: 1920/);
  assert.match(subtitles, /PlayResY: 1080/);
  assert.match(
    subtitles,
    new RegExp(`Style: Default,${DEFAULT_SUBTITLE_FONT_FAMILY},33,`)
  );
  assert.match(
    subtitles,
    /Dialogue: 0,0:00:00\.00,0:00:02\.50,Default,,0,0,0,,Prepare the cup stack/
  );
});

test("buildAssSubtitleFile allows a custom subtitle font family", () => {
  const subtitles = buildAssSubtitleFile(
    [
      {
        startSeconds: 0,
        endSeconds: 1,
        text: "安装型材架到平台。",
      },
    ],
    { width: 1080, height: 1920 },
    { fontFamily: "Custom CJK Font" }
  );

  assert.match(subtitles, /Style: Default,Custom CJK Font,58,/);
  assert.match(subtitles, /安装型材架到平台。/);
});

test("buildAssInstructionOverlayFile creates a boxed two-line overlay style", () => {
  const overlays = buildAssInstructionOverlayFile(
    [
      {
        startSeconds: 1,
        endSeconds: 5,
        text: "Next, unscrew the black knob and slide the electric eye to its highest position.",
      },
    ],
    { width: 1920, height: 1080 }
  );

  assert.match(overlays, /Style: Instruction,/);
  assert.match(overlays, /,3,\d+,\d+,2,/);
  assert.match(
    overlays,
    /Dialogue: 0,0:00:01\.00,0:00:05\.00,Instruction,,0,0,0,,\{\\fad\(200,200\)\}/
  );
  assert.match(overlays, /\\N/);
});

test("normalizeRenderDimensions rounds odd dimensions up for yuv420p", () => {
  assert.deepEqual(normalizeRenderDimensions({ width: 1919, height: 1079 }), {
    width: 1920,
    height: 1080,
  });
});
