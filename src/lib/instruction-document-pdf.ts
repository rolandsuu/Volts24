import PDFDocument from "pdfkit";
import { createWriteStream } from "node:fs";
import path from "node:path";

import type { InstructionDocumentArtifact } from "./instruction-document";

export type InstructionDocumentPdfFrameAsset = {
  stepIndex: number;
  filePath: string;
  timestampSeconds: number;
};

export type RenderInstructionDocumentPdfOptions = {
  document: InstructionDocumentArtifact;
  frameAssets: InstructionDocumentPdfFrameAsset[];
  outputPath: string;
};

const PAGE_SIZE = "A4";
const PAGE_MARGIN = 44;
const CONTENT_WIDTH = 595.28 - PAGE_MARGIN * 2;
const STEP_MIN_HEIGHT = 370;
const STEP_IMAGE_MAX_HEIGHT = 220;
const FONT_PATH = path.join(
  process.cwd(),
  "assets",
  "fonts",
  "NotoSansCJKsc-Regular.otf"
);
const FONT_NAME = "NotoSansCJK";

const COLORS = {
  ink: "#172033",
  muted: "#637083",
  faint: "#f5f7fb",
  line: "#d7dde8",
  primary: "#18223b",
  primarySoft: "#e9eef8",
  caution: "#fff7df",
  cautionLine: "#e3b245",
  checklist: "#eaf7ef",
  checklistLine: "#45a866",
  warning: "#fff0f0",
  warningLine: "#d36b6b",
} as const;

type LocalizedPdfCopy = {
  guideLabel: string;
  overview: string;
  steps: string;
  cautions: string;
  checklist: string;
  warnings: string;
  sourceTime: string;
  generated: string;
  duration: string;
  stepCount: string;
  page: (pageNumber: number, pageCount: number) => string;
};

function isChineseTargetLanguage(targetLanguage: string) {
  const normalized = targetLanguage.trim().toLowerCase().replace(/_/g, "-");

  return (
    normalized === "zh" ||
    normalized.startsWith("zh-") ||
    targetLanguage.trim() === "中文"
  );
}

function getLocalizedCopy(targetLanguage: string): LocalizedPdfCopy {
  if (isChineseTargetLanguage(targetLanguage)) {
    return {
      guideLabel: "客户操作指南",
      overview: "概览",
      steps: "操作步骤",
      cautions: "注意事项",
      checklist: "完成检查",
      warnings: "限制说明",
      sourceTime: "来源时间",
      generated: "生成时间",
      duration: "源视频时长",
      stepCount: "步骤数量",
      page: (pageNumber, pageCount) => `第 ${pageNumber} 页 / 共 ${pageCount} 页`,
    };
  }

  return {
    guideLabel: "Customer Handoff Guide",
    overview: "Overview",
    steps: "Steps",
    cautions: "Things to be careful with",
    checklist: "Final checklist",
    warnings: "Source limitations",
    sourceTime: "Source time",
    generated: "Generated",
    duration: "Source duration",
    stepCount: "Step count",
    page: (pageNumber, pageCount) => `Page ${pageNumber} of ${pageCount}`,
  };
}

function formatTimestamp(seconds: number) {
  const totalSeconds = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;

  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function formatDuration(seconds: number) {
  const totalSeconds = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;

  if (minutes === 0) {
    return `${remainingSeconds}s`;
  }

  return `${minutes}m ${remainingSeconds}s`;
}

function formatDate(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toISOString().slice(0, 10);
}

function ensureSpace(doc: PDFKit.PDFDocument, height: number) {
  if (!doc.page) {
    doc.addPage();
    return;
  }

  if (doc.y + height > doc.page.height - PAGE_MARGIN - 34) {
    doc.addPage();
  }
}

function setFont(
  doc: PDFKit.PDFDocument,
  options: { size: number; color?: string }
) {
  doc.font(FONT_NAME).fontSize(options.size).fillColor(options.color ?? COLORS.ink);
}

function addSectionHeading(doc: PDFKit.PDFDocument, title: string) {
  ensureSpace(doc, 38);
  const x = PAGE_MARGIN;
  const y = doc.y + 4;

  doc
    .roundedRect(x, y, 5, 22, 2)
    .fill(COLORS.primary)
    .fillColor(COLORS.ink);
  setFont(doc, { size: 15 });
  doc.text(title, x + 14, y - 1, {
    width: CONTENT_WIDTH - 14,
    lineGap: 1,
  });
  doc.y = y + 32;
}

function addParagraph(
  doc: PDFKit.PDFDocument,
  text: string,
  options: { size?: number; color?: string; gapAfter?: number } = {}
) {
  const size = options.size ?? 10.5;
  const gapAfter = options.gapAfter ?? 10;
  const height = doc.heightOfString(text, {
    width: CONTENT_WIDTH,
    lineGap: 3,
  });

  ensureSpace(doc, height + gapAfter);
  setFont(doc, { size, color: options.color });
  doc.text(text, PAGE_MARGIN, doc.y, {
    width: CONTENT_WIDTH,
    lineGap: 3,
  });
  doc.moveDown(gapAfter / 12);
}

function addMetadataRow(
  doc: PDFKit.PDFDocument,
  items: Array<{ label: string; value: string }>
) {
  const gap = 10;
  const itemWidth = (CONTENT_WIDTH - gap * (items.length - 1)) / items.length;
  const y = doc.y;

  ensureSpace(doc, 58);

  for (const [index, item] of items.entries()) {
    const x = PAGE_MARGIN + index * (itemWidth + gap);

    doc.roundedRect(x, y, itemWidth, 50, 6).fill(COLORS.faint);
    setFont(doc, { size: 8.5, color: COLORS.muted });
    doc.text(item.label, x + 10, y + 9, {
      width: itemWidth - 20,
      lineGap: 1,
    });
    setFont(doc, { size: 11, color: COLORS.ink });
    doc.text(item.value, x + 10, y + 27, {
      width: itemWidth - 20,
      lineGap: 1,
    });
  }

  doc.y = y + 66;
}

function addBulletList(
  doc: PDFKit.PDFDocument,
  items: readonly string[],
  options: {
    background?: string;
    lineColor?: string;
    title?: string;
    emptyText?: string;
  } = {}
) {
  if (items.length === 0 && !options.emptyText) {
    return;
  }

  const bulletItems = items.length > 0 ? items : [options.emptyText ?? ""];
  const titleHeight = options.title ? 19 : 0;
  const itemHeights = bulletItems.map((item) =>
    doc.heightOfString(`- ${item}`, {
      width: CONTENT_WIDTH - 32,
      lineGap: 3,
    })
  );
  const boxHeight =
    titleHeight + itemHeights.reduce((sum, height) => sum + height + 7, 0) + 18;

  ensureSpace(doc, boxHeight + 10);

  const x = PAGE_MARGIN;
  const y = doc.y;

  if (options.background) {
    doc.roundedRect(x, y, CONTENT_WIDTH, boxHeight, 7).fill(options.background);
    if (options.lineColor) {
      doc
        .roundedRect(x, y, CONTENT_WIDTH, boxHeight, 7)
        .lineWidth(1)
        .stroke(options.lineColor);
    }
  }

  let currentY = y + 11;

  if (options.title) {
    setFont(doc, { size: 11.5, color: COLORS.ink });
    doc.text(options.title, x + 16, currentY, {
      width: CONTENT_WIDTH - 32,
      lineGap: 2,
    });
    currentY += titleHeight;
  }

  setFont(doc, { size: 10, color: COLORS.ink });

  for (const item of bulletItems) {
    const bulletText = `- ${item}`;

    doc.text(bulletText, x + 16, currentY, {
      width: CONTENT_WIDTH - 32,
      lineGap: 3,
    });
    currentY +=
      doc.heightOfString(bulletText, {
        width: CONTENT_WIDTH - 32,
        lineGap: 3,
      }) + 7;
  }

  doc.y = y + boxHeight + 12;
}

function addStepImage(doc: PDFKit.PDFDocument, filePath: string) {
  const maxHeight = STEP_IMAGE_MAX_HEIGHT;

  ensureSpace(doc, maxHeight + 18);

  const x = PAGE_MARGIN;
  const y = doc.y;

  doc
    .roundedRect(x, y, CONTENT_WIDTH, maxHeight + 10, 8)
    .fill("#ffffff")
    .stroke(COLORS.line);
  doc.image(filePath, x + 8, y + 5, {
    fit: [CONTENT_WIDTH - 16, maxHeight],
    align: "center",
    valign: "center",
  });
  doc.y = y + maxHeight + 24;
}

function addCover(doc: PDFKit.PDFDocument, options: {
  document: InstructionDocumentArtifact;
  copy: LocalizedPdfCopy;
}) {
  const { document, copy } = options;

  doc.rect(0, 0, doc.page.width, 174).fill(COLORS.primary);
  setFont(doc, { size: 13, color: "#ffffff" });
  doc.text(copy.guideLabel, PAGE_MARGIN, 52, {
    width: CONTENT_WIDTH,
    lineGap: 2,
  });
  setFont(doc, { size: 26, color: "#ffffff" });
  doc.text(document.title, PAGE_MARGIN, 78, {
    width: CONTENT_WIDTH,
    lineGap: 4,
  });
  doc.y = 205;

  addMetadataRow(doc, [
    { label: copy.generated, value: formatDate(document.completedAt) },
    {
      label: copy.duration,
      value: formatDuration(document.sourceDurationSeconds),
    },
    { label: copy.stepCount, value: String(document.steps.length) },
  ]);

  addSectionHeading(doc, copy.overview);
  addParagraph(doc, document.overview, { size: 11.5, gapAfter: 16 });
}

function addFooters(doc: PDFKit.PDFDocument, copy: LocalizedPdfCopy) {
  const range = doc.bufferedPageRange();
  const pageCount = range.count;

  for (
    let pageIndex = range.start;
    pageIndex < range.start + range.count;
    pageIndex += 1
  ) {
    doc.switchToPage(pageIndex);
    const footerY = doc.page.height - PAGE_MARGIN - 18;

    doc
      .moveTo(PAGE_MARGIN, footerY - 10)
      .lineTo(doc.page.width - PAGE_MARGIN, footerY - 10)
      .lineWidth(0.5)
      .stroke(COLORS.line);
    setFont(doc, { size: 8.5, color: COLORS.muted });
    doc.text(copy.guideLabel, PAGE_MARGIN, footerY, {
      width: CONTENT_WIDTH / 2,
      lineGap: 1,
      continued: false,
    });
    doc.text(copy.page(pageIndex + 1, pageCount), PAGE_MARGIN, footerY, {
      width: CONTENT_WIDTH,
      align: "right",
      lineGap: 1,
    });
  }
}

export async function renderInstructionDocumentPdf({
  document,
  frameAssets,
  outputPath,
}: RenderInstructionDocumentPdfOptions) {
  const copy = getLocalizedCopy(document.targetLanguage);
  const frameAssetByStepIndex = new Map(
    frameAssets.map((asset) => [asset.stepIndex, asset])
  );

  await new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({
      size: PAGE_SIZE,
      margin: PAGE_MARGIN,
      bufferPages: true,
      autoFirstPage: true,
      info: {
        Title: document.title,
        Subject: copy.guideLabel,
        Creator: "Blooclip",
      },
    });
    const output = createWriteStream(outputPath);

    output.on("finish", resolve);
    output.on("error", reject);
    doc.on("error", reject);
    doc.pipe(output);
    doc.registerFont(FONT_NAME, FONT_PATH);

    addCover(doc, { document, copy });
    doc.addPage();
    addSectionHeading(doc, copy.steps);

    for (const step of document.steps) {
      const frameAsset = frameAssetByStepIndex.get(step.stepIndex);
      const timestamp = `${copy.sourceTime}: ${formatTimestamp(
        step.timestampSeconds
      )}`;

      ensureSpace(doc, STEP_MIN_HEIGHT);
      setFont(doc, { size: 17, color: COLORS.ink });
      doc.text(`${step.stepIndex}. ${step.title}`, PAGE_MARGIN, doc.y, {
        width: CONTENT_WIDTH,
        lineGap: 2,
      });
      doc.moveDown(0.35);
      setFont(doc, { size: 9.5, color: COLORS.muted });
      doc.text(timestamp, PAGE_MARGIN, doc.y, {
        width: CONTENT_WIDTH,
        lineGap: 1,
      });
      doc.moveDown(0.75);

      if (frameAsset) {
        addStepImage(doc, frameAsset.filePath);
      }

      addParagraph(doc, step.instruction, { size: 11, gapAfter: 10 });
      addBulletList(doc, step.cautions, {
        title: copy.cautions,
        background: COLORS.caution,
        lineColor: COLORS.cautionLine,
      });
    }

    addSectionHeading(doc, copy.checklist);
    addBulletList(doc, document.checklist, {
      background: COLORS.checklist,
      lineColor: COLORS.checklistLine,
    });

    if (document.warnings.length > 0) {
      addSectionHeading(doc, copy.warnings);
      addBulletList(doc, document.warnings, {
        background: COLORS.warning,
        lineColor: COLORS.warningLine,
      });
    }

    addFooters(doc, copy);
    doc.end();
  });
}
