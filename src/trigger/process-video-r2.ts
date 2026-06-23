import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";

import { r2, R2_BUCKET_NAME } from "../lib/r2";

export async function downloadFromR2(key: string, filePath: string) {
  const result = await r2.send(
    new GetObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
    })
  );

  if (!result.Body) {
    throw new Error("R2 object has no body");
  }

  await pipeline(
    result.Body as NodeJS.ReadableStream,
    createWriteStream(filePath)
  );
}

export async function uploadFileToR2(
  key: string,
  filePath: string,
  contentType: string
) {
  await r2.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
      Body: createReadStream(filePath),
      ContentType: contentType,
    })
  );
}

export async function uploadJsonToR2(key: string, value: unknown) {
  await r2.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
      Body: JSON.stringify(value, null, 2),
      ContentType: "application/json",
    })
  );
}

export async function createSignedR2ReadUrl(
  key: string,
  expiresInSeconds: number
) {
  return getSignedUrl(
    r2,
    new GetObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
    }),
    { expiresIn: expiresInSeconds }
  );
}
