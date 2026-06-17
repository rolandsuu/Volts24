import { getTargetLanguageCode } from "./target-language.ts";
import type { SubtitleCue } from "./video-rendering.ts";

export type SubtitleAlignment = {
  characters: string[];
  characterStartTimesSeconds: number[];
  characterEndTimesSeconds: number[];
};

type SubtitleUnit = {
  text: string;
  startSeconds: number;
  endSeconds: number;
};

export class SubtitleCueGenerationError extends Error {
  readonly code = "subtitle_generation_failed";

  constructor(message: string) {
    super(message);
    this.name = "SubtitleCueGenerationError";
  }
}

const MAX_SUBTITLE_CHARS = 44;
const MAX_CHINESE_SUBTITLE_CHARS = 16;
const MAX_SUBTITLE_DURATION_SECONDS = 4.5;
const MIN_SUBTITLE_DURATION_SECONDS = 0.35;

function isCjkSubtitleCharacter(character: string) {
  return /[\u3400-\u9fff\uf900-\ufaff]/u.test(character);
}

function isSubtitleEndingPunctuation(text: string) {
  return /[.!?。！？]$/u.test(text);
}

function buildSubtitleWords(
  script: string,
  alignment: SubtitleAlignment
): SubtitleUnit[] {
  const scriptCharacters = Array.from(script);
  const words: SubtitleUnit[] = [];
  let currentText = "";
  let currentStart: number | null = null;
  let currentEnd: number | null = null;

  function flushCurrentWord() {
    if (!currentText || currentStart === null || currentEnd === null) {
      return;
    }

    words.push({
      text: currentText,
      startSeconds: currentStart,
      endSeconds: currentEnd,
    });
    currentText = "";
    currentStart = null;
    currentEnd = null;
  }

  for (let index = 0; index < scriptCharacters.length; index += 1) {
    const character = scriptCharacters[index];
    const start = alignment.characterStartTimesSeconds[index];
    const end = alignment.characterEndTimesSeconds[index];

    if (/\s/.test(character)) {
      flushCurrentWord();
      continue;
    }

    if (currentStart === null) {
      currentStart = start;
    }

    currentText += character;
    currentEnd = end;
  }

  flushCurrentWord();

  if (words.length === 0) {
    throw new SubtitleCueGenerationError(
      "Unable to build subtitle words from voiceover script"
    );
  }

  return words;
}

function buildChineseSubtitleUnits(
  script: string,
  alignment: SubtitleAlignment
): SubtitleUnit[] {
  const scriptCharacters = Array.from(script);
  const units: SubtitleUnit[] = [];
  let currentText = "";
  let currentStart: number | null = null;
  let currentEnd: number | null = null;

  function flushCurrentText() {
    if (!currentText || currentStart === null || currentEnd === null) {
      return;
    }

    units.push({
      text: currentText,
      startSeconds: currentStart,
      endSeconds: currentEnd,
    });
    currentText = "";
    currentStart = null;
    currentEnd = null;
  }

  for (let index = 0; index < scriptCharacters.length; index += 1) {
    const character = scriptCharacters[index];
    const start = alignment.characterStartTimesSeconds[index];
    const end = alignment.characterEndTimesSeconds[index];

    if (/\s/.test(character)) {
      flushCurrentText();
      continue;
    }

    if (isCjkSubtitleCharacter(character) || isSubtitleEndingPunctuation(character)) {
      flushCurrentText();
      units.push({
        text: character,
        startSeconds: start,
        endSeconds: end,
      });
      continue;
    }

    if (currentStart === null) {
      currentStart = start;
    }

    currentText += character;
    currentEnd = end;
  }

  flushCurrentText();

  if (units.length === 0) {
    throw new SubtitleCueGenerationError(
      "Unable to build subtitle units from voiceover script"
    );
  }

  return units;
}

function countSubtitleCharacters(text: string) {
  return Array.from(text).length;
}

function createSubtitleCue(
  units: SubtitleUnit[],
  separator = " "
): SubtitleCue {
  const startSeconds = units[0].startSeconds;
  const rawEndSeconds = units[units.length - 1].endSeconds;
  const endSeconds = Math.max(
    rawEndSeconds,
    startSeconds + MIN_SUBTITLE_DURATION_SECONDS
  );

  return {
    startSeconds,
    endSeconds,
    text: units.map((unit) => unit.text).join(separator),
  };
}

function normalizeSubtitleCueTimings(cues: SubtitleCue[]) {
  let previousEnd = 0;

  return cues.map((cue, index) => {
    const nextStart = cues[index + 1]?.startSeconds;
    const startSeconds = Math.max(cue.startSeconds, previousEnd);
    let endSeconds = Math.max(
      cue.endSeconds,
      startSeconds + MIN_SUBTITLE_DURATION_SECONDS
    );

    if (typeof nextStart === "number" && endSeconds > nextStart) {
      endSeconds = Math.max(startSeconds + 0.05, nextStart);
    }

    previousEnd = endSeconds;

    return {
      ...cue,
      startSeconds,
      endSeconds,
    };
  });
}

export function buildSubtitleCues(
  script: string,
  alignment: SubtitleAlignment,
  options: { targetLanguage: string }
): SubtitleCue[] {
  const isChinese = getTargetLanguageCode(options.targetLanguage) === "zh";
  const units = isChinese
    ? buildChineseSubtitleUnits(script, alignment)
    : buildSubtitleWords(script, alignment);
  const cueSeparator = isChinese ? "" : " ";
  const maxCharacters = isChinese
    ? MAX_CHINESE_SUBTITLE_CHARS
    : MAX_SUBTITLE_CHARS;
  const cues: SubtitleCue[] = [];
  let currentUnits: SubtitleUnit[] = [];

  function flushCurrentCue() {
    if (currentUnits.length === 0) {
      return;
    }

    cues.push(createSubtitleCue(currentUnits, cueSeparator));
    currentUnits = [];
  }

  for (const unit of units) {
    if (currentUnits.length > 0) {
      const candidateText = [...currentUnits, unit]
        .map((candidateUnit) => candidateUnit.text)
        .join(cueSeparator);
      const candidateDuration =
        unit.endSeconds - currentUnits[0].startSeconds;

      if (
        countSubtitleCharacters(candidateText) > maxCharacters ||
        candidateDuration > MAX_SUBTITLE_DURATION_SECONDS
      ) {
        flushCurrentCue();
      }
    }

    currentUnits.push(unit);

    const currentText = currentUnits
      .map((currentUnit) => currentUnit.text)
      .join(cueSeparator);

    if (
      isSubtitleEndingPunctuation(unit.text) &&
      (isChinese || countSubtitleCharacters(currentText) >= 20)
    ) {
      flushCurrentCue();
    }
  }

  flushCurrentCue();

  return normalizeSubtitleCueTimings(cues);
}
