export const DEFAULT_UPLOAD_PROMPT =
  "Create a key-event video with voiceover and subtitles";

export const MAX_BATCH_UPLOAD_FILES = 10;

export function getTrimmedString(value: unknown) {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }

  return value.trim();
}

export function normalizePrompt(value: unknown) {
  return getTrimmedString(value) ?? DEFAULT_UPLOAD_PROMPT;
}
