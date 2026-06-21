import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { NextResponse } from "next/server";

import { r2, R2_BUCKET_NAME } from "@/lib/r2";
import { AuthError } from "@/lib/auth";
import { loadAccessibleVideo } from "@/lib/ownership";

export const runtime = "nodejs";

type DownloadContext = {
  params: Promise<{
    videoId: string;
  }>;
};

type DownloadRow = {
  status: string;
  final_r2_key: string | null;
  user_id: string | null;
};

function errorResponse(error: string, status: number) {
  return NextResponse.json({ error }, { status });
}

export async function GET(_request: Request, context: DownloadContext) {
  const { videoId } = await context.params;

  if (!videoId) {
    return errorResponse("Missing videoId", 400);
  }

  let video: DownloadRow;

  try {
    video = await loadAccessibleVideo<DownloadRow>(
      videoId,
      "status,final_r2_key,user_id"
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return errorResponse(error.message, error.status);
    }

    const message =
      error instanceof Error ? error.message : "Failed to load video";

    return errorResponse(message, 500);
  }

  if (video.status !== "completed" || !video.final_r2_key) {
    return errorResponse("Video is not ready to download", 400);
  }

  const downloadUrl = await getSignedUrl(
    r2,
    new GetObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: video.final_r2_key,
    }),
    { expiresIn: 60 * 10 }
  );

  return NextResponse.json({ downloadUrl });
}
