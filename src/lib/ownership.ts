import {
  AuthError,
  assertCanAccessOwnedRecord,
  getAuthenticatedUser,
} from "./auth.ts";
import { supabaseAdmin } from "./supabase-admin.ts";

type OwnedRow = {
  user_id: string | null;
};

function ensureUserIdSelected(select: string) {
  return select.split(",").map((field) => field.trim()).includes("user_id")
    ? select
    : `${select},user_id`;
}

function notFound(message: string) {
  throw new AuthError(message, 404);
}

export async function loadAccessibleBatch<T extends OwnedRow>(
  batchId: string,
  select: string
) {
  const user = await getAuthenticatedUser();
  const { data, error } = await supabaseAdmin
    .from("video_batches")
    .select(ensureUserIdSelected(select))
    .eq("id", batchId)
    .single();

  if (error) {
    if (error.code === "PGRST116") {
      notFound("Video batch not found");
    }

    throw new Error(`Failed to load video batch: ${error.message}`);
  }

  const row = data as unknown as T;
  assertCanAccessOwnedRecord(row.user_id, user);
  return row;
}

export async function loadAccessibleVideo<T extends OwnedRow>(
  videoId: string,
  select: string
) {
  const user = await getAuthenticatedUser();
  const { data, error } = await supabaseAdmin
    .from("videos")
    .select(ensureUserIdSelected(select))
    .eq("id", videoId)
    .single();

  if (error) {
    if (error.code === "PGRST116") {
      notFound("Video not found");
    }

    throw new Error(`Failed to load video: ${error.message}`);
  }

  const row = data as unknown as T;
  assertCanAccessOwnedRecord(row.user_id, user);
  return row;
}
