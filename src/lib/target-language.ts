export function getTargetLanguageCode(targetLanguage: string) {
  const trimmed = targetLanguage.trim();
  const normalized = trimmed.toLowerCase().replace(/_/g, "-");

  if (
    normalized === "zh" ||
    normalized.startsWith("zh-") ||
    normalized === "chinese" ||
    trimmed === "中文"
  ) {
    return "zh";
  }

  if (
    normalized === "en" ||
    normalized.startsWith("en-") ||
    normalized === "english"
  ) {
    return "en";
  }

  return /^[a-z]{2}$/.test(normalized) ? normalized : null;
}

