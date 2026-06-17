import assert from "node:assert/strict";
import test from "node:test";

import { getTargetLanguageCode } from "./target-language.ts";

test("getTargetLanguageCode recognizes supported target languages", () => {
  assert.equal(getTargetLanguageCode("zh"), "zh");
  assert.equal(getTargetLanguageCode("中文"), "zh");
  assert.equal(getTargetLanguageCode("zh-CN"), "zh");
  assert.equal(getTargetLanguageCode("en"), "en");
  assert.equal(getTargetLanguageCode("English"), "en");
});

test("getTargetLanguageCode returns unknown language codes conservatively", () => {
  assert.equal(getTargetLanguageCode("fr"), "fr");
  assert.equal(getTargetLanguageCode("Klingon"), null);
});

