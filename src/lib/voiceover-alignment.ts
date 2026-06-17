import type { SubtitleAlignment } from "./subtitle-cues.ts";

export type VoiceoverAlignmentSource =
  | "assemblyai_words"
  | "duration_fallback";

export type VoiceoverAlignmentResult = {
  alignment: SubtitleAlignment;
  source: VoiceoverAlignmentSource;
  timedWordCount: number;
  matchedCharacterCount: number;
};

type TimedWord = {
  text: string;
  startSeconds: number;
  endSeconds: number;
};

type MatchableScriptCharacter = {
  character: string;
  normalized: string;
  scriptIndex: number;
};

const MIN_CHARACTER_DURATION_SECONDS = 0.01;

function isFinitePositiveDuration(value: number) {
  return Number.isFinite(value) && value > 0;
}

function isMatchableCharacter(character: string) {
  return /[\p{L}\p{N}]/u.test(character);
}

function normalizeMatchCharacter(character: string) {
  return character.normalize("NFKC").toLowerCase();
}

function normalizeMatchText(text: string) {
  return Array.from(text)
    .filter(isMatchableCharacter)
    .map(normalizeMatchCharacter)
    .join("");
}

function parseTimedWords(words: unknown): TimedWord[] {
  if (!Array.isArray(words)) {
    return [];
  }

  const parsedWords: TimedWord[] = [];

  for (const word of words) {
    if (!word || typeof word !== "object") {
      continue;
    }

    const text = (word as { text?: unknown }).text;
    const start = (word as { start?: unknown }).start;
    const end = (word as { end?: unknown }).end;

    if (
      typeof text !== "string" ||
      !text.trim() ||
      typeof start !== "number" ||
      typeof end !== "number" ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end < start
    ) {
      continue;
    }

    parsedWords.push({
      text,
      startSeconds: start / 1000,
      endSeconds: end / 1000,
    });
  }

  return parsedWords.sort(
    (left, right) => left.startSeconds - right.startSeconds
  );
}

function getMatchableScriptCharacters(script: string) {
  return Array.from(script).reduce<MatchableScriptCharacter[]>(
    (characters, character, scriptIndex) => {
      if (!isMatchableCharacter(character)) {
        return characters;
      }

      characters.push({
        character,
        normalized: normalizeMatchCharacter(character),
        scriptIndex,
      });

      return characters;
    },
    []
  );
}

export function buildDurationDistributedAlignment(
  script: string,
  durationSeconds: number
): SubtitleAlignment {
  if (!isFinitePositiveDuration(durationSeconds)) {
    throw new Error("Voiceover duration must be a positive number");
  }

  const characters = Array.from(script);
  const characterCount = characters.length;
  const characterDuration =
    characterCount > 0
      ? durationSeconds / characterCount
      : durationSeconds;

  return {
    characters,
    characterStartTimesSeconds: characters.map((_, index) =>
      roundSeconds(index * characterDuration)
    ),
    characterEndTimesSeconds: characters.map((_, index) =>
      roundSeconds(
        Math.min(durationSeconds, (index + 1) * characterDuration)
      )
    ),
  };
}

function roundSeconds(value: number) {
  return Math.round(value * 1000) / 1000;
}

function assignTimedWordToScriptCharacters(options: {
  timedWord: TimedWord;
  wordOffset: number;
  wordLength: number;
  matchableScriptCharacters: MatchableScriptCharacter[];
  characterStartTimesSeconds: Array<number | null>;
  characterEndTimesSeconds: Array<number | null>;
}) {
  const durationSeconds = Math.max(
    options.timedWord.endSeconds - options.timedWord.startSeconds,
    MIN_CHARACTER_DURATION_SECONDS * options.wordLength
  );
  const characterDuration = durationSeconds / options.wordLength;

  for (let index = 0; index < options.wordLength; index += 1) {
    const scriptIndex =
      options.matchableScriptCharacters[options.wordOffset + index]
        .scriptIndex;
    const startSeconds =
      options.timedWord.startSeconds + characterDuration * index;
    const endSeconds =
      index === options.wordLength - 1
        ? options.timedWord.endSeconds
        : options.timedWord.startSeconds + characterDuration * (index + 1);

    options.characterStartTimesSeconds[scriptIndex] =
      roundSeconds(startSeconds);
    options.characterEndTimesSeconds[scriptIndex] =
      roundSeconds(Math.max(endSeconds, startSeconds + MIN_CHARACTER_DURATION_SECONDS));
  }
}

function normalizeAlignmentTimings(alignment: SubtitleAlignment) {
  let previousStart = 0;
  let previousEnd = 0;

  for (let index = 0; index < alignment.characters.length; index += 1) {
    const start = Math.max(
      0,
      previousStart,
      alignment.characterStartTimesSeconds[index]
    );
    const end = Math.max(
      start + MIN_CHARACTER_DURATION_SECONDS,
      previousEnd,
      alignment.characterEndTimesSeconds[index]
    );

    alignment.characterStartTimesSeconds[index] = roundSeconds(start);
    alignment.characterEndTimesSeconds[index] = roundSeconds(end);
    previousStart = start;
    previousEnd = end;
  }
}

function fillMissingTimings(options: {
  characterStartTimesSeconds: Array<number | null>;
  characterEndTimesSeconds: Array<number | null>;
  durationSeconds: number;
}) {
  let runStart: number | null = null;

  function flushRun(runEndExclusive: number) {
    if (runStart === null) {
      return;
    }

    const previousEnd =
      runStart > 0
        ? options.characterEndTimesSeconds[runStart - 1] ?? 0
        : 0;
    const nextStart =
      runEndExclusive < options.characterStartTimesSeconds.length
        ? options.characterStartTimesSeconds[runEndExclusive] ??
          options.durationSeconds
        : options.durationSeconds;
    const runLength = runEndExclusive - runStart;
    const availableDuration = Math.max(0, nextStart - previousEnd);
    const characterDuration =
      availableDuration > 0
        ? availableDuration / runLength
        : MIN_CHARACTER_DURATION_SECONDS;

    for (let index = runStart; index < runEndExclusive; index += 1) {
      const offset = index - runStart;
      const startSeconds = previousEnd + characterDuration * offset;
      const endSeconds =
        availableDuration > 0
          ? previousEnd + characterDuration * (offset + 1)
          : startSeconds + MIN_CHARACTER_DURATION_SECONDS;

      options.characterStartTimesSeconds[index] = roundSeconds(startSeconds);
      options.characterEndTimesSeconds[index] = roundSeconds(endSeconds);
    }

    runStart = null;
  }

  for (
    let index = 0;
    index < options.characterStartTimesSeconds.length;
    index += 1
  ) {
    if (options.characterStartTimesSeconds[index] === null) {
      runStart ??= index;
      continue;
    }

    flushRun(index);
  }

  flushRun(options.characterStartTimesSeconds.length);
}

export function buildVoiceoverAlignmentFromTranscript(options: {
  script: string;
  transcriptWords: unknown;
  durationSeconds: number;
}): VoiceoverAlignmentResult {
  const fallbackAlignment = buildDurationDistributedAlignment(
    options.script,
    options.durationSeconds
  );
  const timedWords = parseTimedWords(options.transcriptWords);

  if (timedWords.length === 0) {
    return {
      alignment: fallbackAlignment,
      source: "duration_fallback",
      timedWordCount: 0,
      matchedCharacterCount: 0,
    };
  }

  const matchableScriptCharacters = getMatchableScriptCharacters(
    options.script
  );
  const normalizedScript = matchableScriptCharacters
    .map((character) => character.normalized)
    .join("");

  if (!normalizedScript) {
    return {
      alignment: fallbackAlignment,
      source: "duration_fallback",
      timedWordCount: timedWords.length,
      matchedCharacterCount: 0,
    };
  }

  const characterStartTimesSeconds =
    fallbackAlignment.characterStartTimesSeconds.map(() => null);
  const characterEndTimesSeconds =
    fallbackAlignment.characterEndTimesSeconds.map(() => null);
  let cursor = 0;
  let matchedCharacterCount = 0;

  for (const timedWord of timedWords) {
    const normalizedWord = normalizeMatchText(timedWord.text);

    if (!normalizedWord) {
      continue;
    }

    const wordOffset = normalizedScript.indexOf(normalizedWord, cursor);

    if (wordOffset < 0) {
      continue;
    }

    assignTimedWordToScriptCharacters({
      timedWord,
      wordOffset,
      wordLength: normalizedWord.length,
      matchableScriptCharacters,
      characterStartTimesSeconds,
      characterEndTimesSeconds,
    });
    cursor = wordOffset + normalizedWord.length;
    matchedCharacterCount += normalizedWord.length;
  }

  if (matchedCharacterCount === 0) {
    return {
      alignment: fallbackAlignment,
      source: "duration_fallback",
      timedWordCount: timedWords.length,
      matchedCharacterCount,
    };
  }

  fillMissingTimings({
    characterStartTimesSeconds,
    characterEndTimesSeconds,
    durationSeconds: options.durationSeconds,
  });

  const alignment: SubtitleAlignment = {
    characters: fallbackAlignment.characters,
    characterStartTimesSeconds: characterStartTimesSeconds.map(
      (startSeconds, index) =>
        startSeconds ?? fallbackAlignment.characterStartTimesSeconds[index]
    ),
    characterEndTimesSeconds: characterEndTimesSeconds.map(
      (endSeconds, index) =>
        endSeconds ?? fallbackAlignment.characterEndTimesSeconds[index]
    ),
  };

  normalizeAlignmentTimings(alignment);

  return {
    alignment,
    source: "assemblyai_words",
    timedWordCount: timedWords.length,
    matchedCharacterCount,
  };
}
