import type { User } from "@supabase/supabase-js";

import {
  createDevBypassUser,
  isAuthDisabledForDev,
  isDevBypassUser,
  getUserOwnershipId,
} from "./dev-auth.ts";
import { createSupabaseServerClient } from "./supabase-server.ts";

export { getUserOwnershipId, isAuthDisabledForDev, isDevBypassUser };

export type AuthenticatedUser = {
  id: string;
  email: string | null;
  isDevBypass?: boolean;
};

export class AuthError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

function toAuthenticatedUser(user: User): AuthenticatedUser {
  return {
    id: user.id,
    email: user.email ?? null,
  };
}

export async function getAuthenticatedUser() {
  if (isAuthDisabledForDev()) {
    return createDevBypassUser();
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();

  if (error || !data.user) {
    return null;
  }

  return toAuthenticatedUser(data.user);
}

export async function requireAuthenticatedUser() {
  const user = await getAuthenticatedUser();

  if (!user) {
    throw new AuthError("Sign in to continue", 401);
  }

  return user;
}

export function assertCanAccessOwnedRecord(
  ownerUserId: string | null,
  user: AuthenticatedUser | null
) {
  if (isAuthDisabledForDev()) {
    return;
  }

  if (!ownerUserId) {
    return;
  }

  if (!user) {
    throw new AuthError("Sign in to access this upload", 401);
  }

  if (ownerUserId !== user.id) {
    throw new AuthError("Upload not found", 404);
  }
}

export function getSafeNextPath(value: unknown) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return "/";
  }

  return value;
}
