import { NextResponse } from "next/server";

import {
  createUploadSession,
  parseCreateUploadSessionBody,
  UploadValidationError,
} from "@/lib/upload-sessions";
import {
  AuthError,
  getUserOwnershipId,
  requireAuthenticatedUser,
} from "@/lib/auth";

export const runtime = "nodejs";

type CreateBatchUploadBody = {
  title?: unknown;
  targetLanguage?: unknown;
  videos?: unknown;
  prompt?: unknown;
};

function errorResponse(error: string, status: number) {
  return NextResponse.json({ error }, { status });
}

export async function POST(request: Request) {
  let body: CreateBatchUploadBody;

  try {
    body = (await request.json()) as CreateBatchUploadBody;
  } catch {
    return errorResponse("Request body must be valid JSON", 400);
  }

  try {
    const user = await requireAuthenticatedUser();
    const uploadSession = await createUploadSession(
      {
        ...parseCreateUploadSessionBody(body),
        userId: getUserOwnershipId(user),
      }
    );

    return NextResponse.json(uploadSession);
  } catch (error) {
    if (error instanceof AuthError) {
      return errorResponse(error.message, error.status);
    }

    if (error instanceof UploadValidationError) {
      return errorResponse(error.message, error.status);
    }

    const message =
      error instanceof Error ? error.message : "Failed to create upload URLs";

    return errorResponse(message, 500);
  }
}
