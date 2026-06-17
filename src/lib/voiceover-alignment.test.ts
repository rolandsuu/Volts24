import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDurationDistributedAlignment,
  buildVoiceoverAlignmentFromTranscript,
} from "./voiceover-alignment.ts";

test("buildVoiceoverAlignmentFromTranscript maps English word timings", () => {
  const script = "Prepare the cup stack.";
  const result = buildVoiceoverAlignmentFromTranscript({
    script,
    durationSeconds: 1.6,
    transcriptWords: [
      { text: "Prepare", start: 0, end: 500 },
      { text: "the", start: 600, end: 700 },
      { text: "cup", start: 800, end: 950 },
      { text: "stack", start: 1000, end: 1400 },
    ],
  });

  assert.equal(result.source, "assemblyai_words");
  assert.equal(result.timedWordCount, 4);
  assert.equal(result.matchedCharacterCount, 18);
  assert.equal(result.alignment.characterStartTimesSeconds[0], 0);
  assert.equal(result.alignment.characterEndTimesSeconds[6], 0.5);
  assert.equal(result.alignment.characterStartTimesSeconds[18], 1.16);
});

test("buildVoiceoverAlignmentFromTranscript interpolates punctuation and whitespace", () => {
  const script = "Hello, world!";
  const result = buildVoiceoverAlignmentFromTranscript({
    script,
    durationSeconds: 1.4,
    transcriptWords: [
      { text: "Hello", start: 100, end: 500 },
      { text: "world", start: 800, end: 1200 },
    ],
  });

  assert.equal(result.source, "assemblyai_words");
  assert.equal(result.alignment.characterStartTimesSeconds[0], 0.1);
  assert.equal(result.alignment.characterEndTimesSeconds[4], 0.5);
  assert.equal(result.alignment.characterStartTimesSeconds[5], 0.5);
  assert.equal(result.alignment.characterEndTimesSeconds[6], 0.8);
  assert.equal(result.alignment.characterStartTimesSeconds[7], 0.8);
  assert.equal(result.alignment.characterEndTimesSeconds[12], 1.4);
});

test("buildVoiceoverAlignmentFromTranscript maps Chinese transcript segments", () => {
  const script = "安装型材架到平台。";
  const result = buildVoiceoverAlignmentFromTranscript({
    script,
    durationSeconds: 2,
    transcriptWords: [{ text: "安装型材架到平台", start: 0, end: 1600 }],
  });

  assert.equal(result.source, "assemblyai_words");
  assert.equal(result.matchedCharacterCount, 8);
  assert.equal(result.alignment.characterStartTimesSeconds[0], 0);
  assert.equal(result.alignment.characterEndTimesSeconds[7], 1.6);
  assert.equal(result.alignment.characterStartTimesSeconds[8], 1.6);
  assert.equal(result.alignment.characterEndTimesSeconds[8], 2);
});

test("buildVoiceoverAlignmentFromTranscript falls back when words are missing", () => {
  const script = "No words.";
  const result = buildVoiceoverAlignmentFromTranscript({
    script,
    durationSeconds: 2,
    transcriptWords: [],
  });

  assert.equal(result.source, "duration_fallback");
  assert.equal(result.timedWordCount, 0);
  assert.equal(result.matchedCharacterCount, 0);
  assert.equal(result.alignment.characters.length, Array.from(script).length);
  assert.equal(result.alignment.characterStartTimesSeconds[0], 0);
  assert.equal(result.alignment.characterEndTimesSeconds.at(-1), 2);
});

test("buildDurationDistributedAlignment covers the full voiceover duration", () => {
  const alignment = buildDurationDistributedAlignment("abcd", 2);

  assert.deepEqual(alignment.characterStartTimesSeconds, [0, 0.5, 1, 1.5]);
  assert.deepEqual(alignment.characterEndTimesSeconds, [0.5, 1, 1.5, 2]);
});
