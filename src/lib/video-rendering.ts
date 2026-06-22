export type RenderDimensions = {
  width: number;
  height: number;
};

export type SubtitleCue = {
  startSeconds: number;
  endSeconds: number;
  text: string;
};

export type InstructionOverlayCue = {
  startSeconds: number;
  endSeconds: number;
  text: string;
};

export type AssSubtitleOptions = {
  fontFamily?: string;
};

const BASE_SUBTITLE_WIDTH = 1080;
const BASE_SUBTITLE_HEIGHT = 1920;
const BASE_SUBTITLE_FONT_SIZE = 58;
const BASE_SUBTITLE_MARGIN_X = 80;
const BASE_SUBTITLE_MARGIN_V = 120;
const BASE_SUBTITLE_OUTLINE = 4;
const BASE_SUBTITLE_SHADOW = 1;
const BASE_OVERLAY_FONT_SIZE = 64;
const BASE_OVERLAY_MARGIN_X = 96;
const BASE_OVERLAY_MARGIN_V = 138;
const BASE_OVERLAY_OUTLINE = 18;
const BASE_OVERLAY_SHADOW = 1;
export const DEFAULT_SUBTITLE_FONT_FAMILY = "Noto Sans CJK SC";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeRenderDimension(value: number, fieldName: string) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Video ${fieldName} must be a positive number`);
  }

  const rounded = Math.round(value);
  const even = rounded % 2 === 0 ? rounded : rounded + 1;

  return Math.max(2, even);
}

export function normalizeRenderDimensions(
  dimensions: RenderDimensions
): RenderDimensions {
  return {
    width: normalizeRenderDimension(dimensions.width, "width"),
    height: normalizeRenderDimension(dimensions.height, "height"),
  };
}

function readPositiveNumber(value: unknown, fieldName: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`ffprobe video stream is missing ${fieldName}`);
  }

  return value;
}

function parseRatio(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(value.trim());

  if (!match) {
    return null;
  }

  const numerator = Number(match[1]);
  const denominator = Number(match[2]);

  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    numerator <= 0 ||
    denominator <= 0
  ) {
    return null;
  }

  return numerator / denominator;
}

function readRotationDegrees(stream: Record<string, unknown>) {
  const tags = stream.tags;

  if (isRecord(tags)) {
    const rotate = Number(tags.rotate);

    if (Number.isFinite(rotate)) {
      return rotate;
    }
  }

  const sideDataList = stream.side_data_list;

  if (Array.isArray(sideDataList)) {
    for (const sideData of sideDataList) {
      if (!isRecord(sideData)) {
        continue;
      }

      const rotation = Number(sideData.rotation);

      if (Number.isFinite(rotation)) {
        return rotation;
      }
    }
  }

  return 0;
}

function isQuarterTurn(rotationDegrees: number) {
  const normalized = ((Math.round(rotationDegrees) % 360) + 360) % 360;

  return normalized === 90 || normalized === 270;
}

export function readRenderDimensionsFromFfprobe(
  ffprobeOutput: unknown
): RenderDimensions {
  if (!isRecord(ffprobeOutput) || !Array.isArray(ffprobeOutput.streams)) {
    throw new Error("ffprobe output did not include video streams");
  }

  const stream = ffprobeOutput.streams.find(isRecord);

  if (!stream) {
    throw new Error("ffprobe output did not include a video stream");
  }

  let width = readPositiveNumber(stream.width, "width");
  let height = readPositiveNumber(stream.height, "height");
  const sampleAspectRatio = parseRatio(stream.sample_aspect_ratio);

  if (sampleAspectRatio && sampleAspectRatio !== 1) {
    width *= sampleAspectRatio;
  }

  const displayAspectRatio = parseRatio(stream.display_aspect_ratio);

  if (displayAspectRatio) {
    const currentAspectRatio = width / height;

    if (Math.abs(currentAspectRatio - displayAspectRatio) > 0.01) {
      if (currentAspectRatio > displayAspectRatio) {
        width = height * displayAspectRatio;
      } else {
        height = width / displayAspectRatio;
      }
    }
  }

  if (isQuarterTurn(readRotationDegrees(stream))) {
    [width, height] = [height, width];
  }

  return normalizeRenderDimensions({ width, height });
}

export function buildClipScalePadFilters(renderDimensions: RenderDimensions) {
  const dimensions = normalizeRenderDimensions(renderDimensions);

  return [
    `scale=${dimensions.width}:${dimensions.height}:force_original_aspect_ratio=decrease`,
    `pad=${dimensions.width}:${dimensions.height}:(ow-iw)/2:(oh-ih)/2`,
    "setsar=1",
  ];
}

function formatAssTimestamp(seconds: number) {
  const totalCentiseconds = Math.max(0, Math.round(seconds * 100));
  const hours = Math.floor(totalCentiseconds / 360000);
  const minutes = Math.floor((totalCentiseconds % 360000) / 6000);
  const wholeSeconds = Math.floor((totalCentiseconds % 6000) / 100);
  const centiseconds = totalCentiseconds % 100;

  return `${hours}:${String(minutes).padStart(2, "0")}:${String(
    wholeSeconds
  ).padStart(2, "0")}.${String(centiseconds).padStart(2, "0")}`;
}

function escapeAssText(text: string) {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/{/g, "\\{")
    .replace(/}/g, "\\}")
    .replace(/\r?\n/g, "\\N")
    .trim();
}

function hasWhitespace(text: string) {
  return /\s/.test(text);
}

function clampText(value: string, maxLength: number) {
  const trimmed = value.trim().replace(/\s+/g, " ");

  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function splitInstructionCaptionLine(text: string, maxLineLength: number) {
  if (!hasWhitespace(text)) {
    return [text.slice(0, maxLineLength), text.slice(maxLineLength)];
  }

  const words = text.split(/\s+/);
  const lines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    const candidate = currentLine ? `${currentLine} ${word}` : word;

    if (candidate.length <= maxLineLength || !currentLine) {
      currentLine = candidate;
      continue;
    }

    lines.push(currentLine);
    currentLine = word;
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines;
}

function clampInstructionCaptionToTwoLines(text: string) {
  const normalized = clampText(text, 96);
  const maxLineLength = hasWhitespace(normalized) ? 42 : 24;
  const lines = splitInstructionCaptionLine(normalized, maxLineLength);

  if (lines.length <= 2) {
    return lines.join("\n");
  }

  return [
    lines[0],
    clampText(lines.slice(1).join(" "), maxLineLength),
  ].join("\n");
}

function sanitizeAssStyleValue(value: string) {
  return value.replace(/,/g, " ").trim();
}

function scaleSubtitleMetric(
  value: number,
  renderDimensions: RenderDimensions,
  minimum: number
) {
  const dimensions = normalizeRenderDimensions(renderDimensions);
  const scale = Math.min(
    dimensions.width / BASE_SUBTITLE_WIDTH,
    dimensions.height / BASE_SUBTITLE_HEIGHT
  );

  return Math.max(minimum, Math.round(value * scale));
}

export function buildAssSubtitleFile(
  cues: SubtitleCue[],
  renderDimensions: RenderDimensions,
  options: AssSubtitleOptions = {}
) {
  const dimensions = normalizeRenderDimensions(renderDimensions);
  const fontFamily =
    sanitizeAssStyleValue(options.fontFamily ?? DEFAULT_SUBTITLE_FONT_FAMILY) ||
    DEFAULT_SUBTITLE_FONT_FAMILY;
  const fontSize = scaleSubtitleMetric(
    BASE_SUBTITLE_FONT_SIZE,
    dimensions,
    18
  );
  const marginX = scaleSubtitleMetric(BASE_SUBTITLE_MARGIN_X, dimensions, 16);
  const marginV = scaleSubtitleMetric(BASE_SUBTITLE_MARGIN_V, dimensions, 24);
  const outline = scaleSubtitleMetric(BASE_SUBTITLE_OUTLINE, dimensions, 1);
  const shadow = scaleSubtitleMetric(BASE_SUBTITLE_SHADOW, dimensions, 1);
  const dialogueLines = cues.map(
    (cue) =>
      `Dialogue: 0,${formatAssTimestamp(cue.startSeconds)},${formatAssTimestamp(
        cue.endSeconds
      )},Default,,0,0,0,,${escapeAssText(cue.text)}`
  );

  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    `PlayResX: ${dimensions.width}`,
    `PlayResY: ${dimensions.height}`,
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,${fontFamily},${fontSize},&H00FFFFFF,&H00FFFFFF,&H00111111,&H99000000,-1,0,0,0,100,100,0,0,1,${outline},${shadow},2,${marginX},${marginX},${marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...dialogueLines,
    "",
  ].join("\n");
}

export function buildAssInstructionOverlayFile(
  cues: InstructionOverlayCue[],
  renderDimensions: RenderDimensions,
  options: AssSubtitleOptions = {}
) {
  const dimensions = normalizeRenderDimensions(renderDimensions);
  const fontFamily =
    sanitizeAssStyleValue(options.fontFamily ?? DEFAULT_SUBTITLE_FONT_FAMILY) ||
    DEFAULT_SUBTITLE_FONT_FAMILY;
  const fontSize = scaleSubtitleMetric(BASE_OVERLAY_FONT_SIZE, dimensions, 20);
  const marginX = scaleSubtitleMetric(BASE_OVERLAY_MARGIN_X, dimensions, 18);
  const marginV = scaleSubtitleMetric(BASE_OVERLAY_MARGIN_V, dimensions, 28);
  const outline = scaleSubtitleMetric(BASE_OVERLAY_OUTLINE, dimensions, 6);
  const shadow = scaleSubtitleMetric(BASE_OVERLAY_SHADOW, dimensions, 1);
  const dialogueLines = cues.map((cue) => {
    const captionText = escapeAssText(
      clampInstructionCaptionToTwoLines(cue.text)
    );

    return `Dialogue: 0,${formatAssTimestamp(
      cue.startSeconds
    )},${formatAssTimestamp(
      cue.endSeconds
    )},Instruction,,0,0,0,,{\\fad(200,200)}${captionText}`;
  });

  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    `PlayResX: ${dimensions.width}`,
    `PlayResY: ${dimensions.height}`,
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Instruction,${fontFamily},${fontSize},&H00FFFFFF,&H00FFFFFF,&H00101010,&H99000000,-1,0,0,0,100,100,0,0,3,${outline},${shadow},2,${marginX},${marginX},${marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...dialogueLines,
    "",
  ].join("\n");
}
