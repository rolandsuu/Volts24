import assert from "node:assert/strict";
import test from "node:test";

import {
  getOpenAiErrorMessage,
  summarizeOpenAiErrorBody,
} from "./openai-error.ts";

test("summarizeOpenAiErrorBody returns JSON error messages", () => {
  assert.equal(
    summarizeOpenAiErrorBody({
      error: {
        message: "Rate limit reached",
      },
    }),
    "Rate limit reached"
  );
});

test("getOpenAiErrorMessage summarizes HTML provider errors", () => {
  assert.equal(
    getOpenAiErrorMessage(
      "<!DOCTYPE html><html><head><title>api.openai.com | 520</title></head></html>",
      "OpenAI edit planning failed with HTTP 520"
    ),
    "OpenAI edit planning failed with HTTP 520: non-JSON HTML response from api.openai.com"
  );
});

test("summarizeOpenAiErrorBody caps plain text provider errors", () => {
  const summary = summarizeOpenAiErrorBody("x".repeat(700));

  assert.equal(summary?.length, 500);
});
