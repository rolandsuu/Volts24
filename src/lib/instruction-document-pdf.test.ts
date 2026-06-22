import assert from "node:assert/strict";
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
    title: "安装前检查",
    overview: "这份指南帮助客户完成关键检查并避免遗漏。",
    targetLanguage: "zh",
    steps: [
      {
        stepIndex: 1,
        title: "确认设备状态",
        instruction: "检查屏幕和指示灯，确认设备已经进入准备状态。",
        cautions: ["不要跳过状态确认，避免后续步骤基于错误状态执行。"],
        timestampSeconds: 8,
        sourceStartSeconds: 6,
        sourceEndSeconds: 12,
        keyFrame: {
          visualFrameIndex: 1,
          timestampSeconds: 8,
          altText: "设备屏幕处于准备状态。",
          r2Key: "artifacts/video-1/instruction-document/frames/step-01.jpg",
          sizeBytes: 1200,
        },
      },
    ],
    checklist: [
      "确认设备状态正确。",
      "确认所有连接已经固定。",
      "确认客户可以复述关键步骤。",
    ],
    warnings: ["源视频的部分快速动作可能不够清晰。"],
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
