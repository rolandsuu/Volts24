import { NextResponse } from "next/server";

import {
  UploadValidationError,
  createSingleVideoUploadSession,
} from "@/lib/upload-sessions";
import {
  AuthError,
  getUserOwnershipId,
  requireAuthenticatedUser,
} from "@/lib/auth";

export const runtime = "nodejs";

type CreateUploadBody = {
  filename?: unknown;
  contentType?: unknown;
  size?: unknown;
  prompt?: unknown;
  targetLanguage?: unknown;
};

function errorResponse(error: string, status: number) {
  return NextResponse.json({ error }, { status });
}

export async function POST(request: Request) {
  let body: CreateUploadBody;

  try {
    body = (await request.json()) as CreateUploadBody;
  } catch {
    return errorResponse("Request body must be valid JSON", 400);
  }

  try {
    const user = await requireAuthenticatedUser();

    return NextResponse.json(
      await createSingleVideoUploadSession(
        body,
        undefined,
        getUserOwnershipId(user)
      )
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return errorResponse(error.message, error.status);
    }

    if (error instanceof UploadValidationError) {
      return errorResponse(error.message, error.status);
    }

    const message =
      error instanceof Error ? error.message : "Failed to create upload URL";

    return errorResponse(message, 500);
  }
}
