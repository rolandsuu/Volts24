import assert from "node:assert/strict";
import test from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://127.0.0.1:54321";
process.env.SUPABASE_SECRET_KEY ??= "test-service-key";

const { RECENT_VIDEO_HISTORY_WINDOW_MS, filterRecentVideoJobs } = await import(
  "./video-history.ts"
);

const nowMs = Date.UTC(2026, 5, 22, 6, 0, 0);

function historyItem(id: string, updatedAt: string) {
  return {
    id,
    title: id,
    targetLanguage: "zh",
    expectedVideoCount: 1,
    videoCount: 1,
    activeCount: 0,
    completedCount: 1,
    failedCount: 0,
    status: "completed" as const,
    updatedAt,
    createdAt: updatedAt,
  };
}

test("filterRecentVideoJobs includes jobs updated within 7 days", () => {
  const updatedAt = new Date(nowMs - 6 * 24 * 60 * 60 * 1000).toISOString();

  assert.deepEqual(
    filterRecentVideoJobs([historyItem("recent", updatedAt)], nowMs),
    [historyItem("recent", updatedAt)]
  );
});

test("filterRecentVideoJobs includes jobs updated exactly 7 days ago", () => {
  const updatedAt = new Date(nowMs - RECENT_VIDEO_HISTORY_WINDOW_MS).toISOString();

  assert.deepEqual(
    filterRecentVideoJobs([historyItem("boundary", updatedAt)], nowMs),
    [historyItem("boundary", updatedAt)]
  );
});

test("filterRecentVideoJobs excludes jobs older than 7 days", () => {
  const updatedAt = new Date(
    nowMs - RECENT_VIDEO_HISTORY_WINDOW_MS - 1
  ).toISOString();

  assert.deepEqual(
    filterRecentVideoJobs([historyItem("old", updatedAt)], nowMs),
    []
  );
});

test("filterRecentVideoJobs ignores invalid update timestamps", () => {
  assert.deepEqual(
    filterRecentVideoJobs([historyItem("invalid", "not-a-date")], nowMs),
    []
  );
});
