import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { renderInstructionDocumentPdf } from "./instruction-document-pdf.ts";
import type { InstructionDocumentArtifact } from "./instruction-document.ts";

function sampleArtifact(): InstructionDocumentArtifact {
  return {
    videoId: "video-1",
    sourceR2Key: "uploads/video-1/source.mp4",
    transcriptR2Key: "artifacts/video-1/transcript.json",
    visualTimelineR2Key: "artifacts/video-1/visual-timeline.json",
    editPlanR2Key: "artifacts/video-1/edit-plan.json",
    provider: "openai",
    providerRequestId: "resp_test",
    model: "gpt-5.5",
    completedAt: "2026-06-22T00:00:00.000Z",
    sourceDurationSeconds: 95,
    title: "Startup Inspection Checklist",
    overview: "This guide helps the customer complete routine inspection and startup checks.",
    targetLanguage: "en",
    safetyPrecautions: ["Clear the work area and verify no loose parts are present."],
    requiredToolsAndComponents: ["Safety gloves", "Safety glasses", "Operation manual"],
    finalInspectionChecklist: [
      "Verify the device status is normal.",
      "Verify all connections are fully secured.",
      "Verify safety checks were completed and logged.",
    ],
    maintenanceRecommendations: ["Clean the enclosure surface and secure the power lock."],
    steps: [
      {
        stepIndex: 1,
        title: "Verify equipment status",
        purpose: "Confirm the system is ready for operation.",
        procedure:
          "Check the display and indicators to confirm the machine is in ready mode before continuing.",
        inspectionCriteria: [
          "Ready indicators are visible and stable.",
          "No active alarm panel is shown.",
        ],
        importantNotes: [],
        timestampSeconds: 8,
        sourceStartSeconds: 6,
        sourceEndSeconds: 12,
        keyFrame: {
          visualFrameIndex: 1,
          timestampSeconds: 8,
          altText: "The machine control screen shows a ready state.",
          r2Key: "artifacts/video-1/instruction-document/frames/step-01.jpg",
          sizeBytes: 1200,
        },
      },
    ],
  };
}

test("renderInstructionDocumentPdf writes a non-empty PDF", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "blooclip-pdf-test-"));
  const outputPath = path.join(tmpDir, "instructions.pdf");

  try {
    await renderInstructionDocumentPdf({
      document: sampleArtifact(),
      frameAssets: [],
      outputPath,
    });

    const pdf = await readFile(outputPath);

    assert.ok(pdf.length > 1024);
    assert.equal(pdf.subarray(0, 4).toString("utf8"), "%PDF");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("renderInstructionDocumentPdf excludes restricted text from output structure", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "blooclip-pdf-test-"));
  const outputPath = path.join(tmpDir, "instructions.pdf");

  try {
    await renderInstructionDocumentPdf({
      document: sampleArtifact(),
      frameAssets: [],
      outputPath,
    });

    const pdf = await readFile(outputPath);
    const pdfText = pdf.toString("utf8").toLowerCase();
    const forbiddenPhrases = [
      "source time",
      "frame number",
      "timestamps",
      "version",
      "revision",
      "limitations",
      "release date",
    ];

    for (const phrase of forbiddenPhrases) {
      assert.ok(
        !pdfText.includes(phrase),
        `Output contains restricted phrase: ${phrase}`
      );
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("renderInstructionDocumentPdf does not require PDFKit Helvetica AFM data", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "blooclip-pdf-test-"));
  const outputPath = path.join(tmpDir, "instructions.pdf");
  const originalReadFileSync = fs.readFileSync;

  fs.readFileSync = function readFileSyncWithoutHelveticaAfm(
    this: typeof fs,
    file: fs.PathOrFileDescriptor,
    options?: BufferEncoding | { encoding?: BufferEncoding | null; flag?: string } | null
  ) {
    if (typeof file === "string" && file.endsWith("Helvetica.afm")) {
      throw new Error("Helvetica.afm should not be read");
    }

    return originalReadFileSync.call(this, file, options as never);
  } as typeof fs.readFileSync;

  try {
    await renderInstructionDocumentPdf({
      document: sampleArtifact(),
      frameAssets: [],
      outputPath,
    });

    const pdf = await readFile(outputPath);

    assert.ok(pdf.length > 1024);
    assert.equal(pdf.subarray(0, 4).toString("utf8"), "%PDF");
  } finally {
    fs.readFileSync = originalReadFileSync;
    await rm(tmpDir, { recursive: true, force: true });
  }
});
