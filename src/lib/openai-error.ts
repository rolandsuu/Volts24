export function summarizeOpenAiErrorBody(body: unknown) {
  if (body && typeof body === "object" && "error" in body) {
    const error = (body as { error?: unknown }).error;

    if (typeof error === "string" && error.trim()) {
      return error.trim();
    }

    if (error && typeof error === "object" && "message" in error) {
      const message = (error as { message?: unknown }).message;

      if (typeof message === "string" && message.trim()) {
        return message.trim();
      }
    }
  }

  if (typeof body === "string" && body.trim()) {
    const trimmed = body.trim();

    if (/^\s*<!doctype html/i.test(trimmed) || /^\s*<html[\s>]/i.test(trimmed)) {
      return "non-JSON HTML response from api.openai.com";
    }

    return trimmed.slice(0, 500);
  }

  return null;
}

export function getOpenAiErrorMessage(body: unknown, fallback: string) {
  const summary = summarizeOpenAiErrorBody(body);

  if (!summary) {
    return fallback;
  }

  if (summary === fallback || summary.startsWith(`${fallback}:`)) {
    return summary;
  }

  return `${fallback}: ${summary}`;
}
