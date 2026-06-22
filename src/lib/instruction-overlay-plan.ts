export type InstructionOverlayTransition = {
  type: "hard_cut" | "fade";
  durationFrames: number;
  reason: string;
};

export type InstructionOverlayOptionalCrop = {
  type: "none" | "subtle_zoom";
  scale: number;
  xPercent: number;
  yPercent: number;
  reason: string;
};

export type InstructionOverlaySegment = {
  segmentIndex: number;
  overlayCaption: string;
  captionStart: number;
  captionEnd: number;
  holdAfterActionSeconds: number;
  transitionToNext: InstructionOverlayTransition;
  optionalCrop: InstructionOverlayOptionalCrop;
};

export type InstructionOverlayPlan = {
  style: "instruction_overlay";
  targetLanguage: string;
  segments: InstructionOverlaySegment[];
  warnings: string[];
};

export type InstructionOverlayRenderCue = {
  segmentIndex: number;
  text: string;
  startSeconds: number;
  endSeconds: number;
};

export type InstructionOverlayRenderSegment = {
  segmentIndex: number;
  sourceStart: number;
  sourceEnd: number;
  sourceDurationSeconds: number;
  holdAfterActionSeconds: number;
  renderStartSeconds: number;
  renderEndSeconds: number;
  optionalCrop: InstructionOverlayOptionalCrop;
  transitionToNext: InstructionOverlayTransition;
};

export type InstructionOverlayRenderPlan = {
  segments: InstructionOverlayRenderSegment[];
  cues: InstructionOverlayRenderCue[];
  durationSeconds: number;
};

export type EditPlanSegmentReference = {
  segmentIndex: number;
  sourceStart: number;
  sourceEnd: number;
};

export class InstructionOverlayPlanValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstructionOverlayPlanValidationError";
  }
}

export const INSTRUCTION_OVERLAY_PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["style", "targetLanguage", "segments", "warnings"],
  properties: {
    style: {
      type: "string",
      enum: ["instruction_overlay"],
      description: "Render style for Vidocu-style instructional overlays.",
    },
    targetLanguage: {
      type: "string",
      description: "The requested caption language.",
    },
    segments: {
      type: "array",
      minItems: 1,
      description:
        "One overlay render decision for each selected edit-plan segment.",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "segmentIndex",
          "overlayCaption",
          "captionStart",
          "captionEnd",
          "holdAfterActionSeconds",
          "transitionToNext",
          "optionalCrop",
        ],
        properties: {
          segmentIndex: {
            type: "integer",
            minimum: 1,
            description:
              "The selected edit-plan segmentIndex this overlay belongs to.",
          },
          overlayCaption: {
            type: "string",
            description:
              "One readable action instruction, not word-by-word subtitles.",
          },
          captionStart: {
            type: "number",
            minimum: 0,
            description:
              "Caption start in seconds relative to the selected segment.",
          },
          captionEnd: {
            type: "number",
            minimum: 0,
            description:
              "Caption end in seconds relative to the selected segment, including hold time if helpful.",
          },
          holdAfterActionSeconds: {
            type: "number",
            minimum: 0,
            maximum: 1.2,
            description:
              "Extra freeze hold after the segment action so the final position is readable.",
          },
          transitionToNext: {
            type: "object",
            additionalProperties: false,
            required: ["type", "durationFrames", "reason"],
            properties: {
              type: {
                type: "string",
                enum: ["hard_cut", "fade"],
                description:
                  "Use hard_cut by default; fade only for visually harsh cuts.",
              },
              durationFrames: {
                type: "integer",
                minimum: 0,
                maximum: 10,
                description:
                  "0 for hard cuts, or 6-10 frames for a minimal fade.",
              },
              reason: {
                type: "string",
                description: "Short reason for this transition choice.",
              },
            },
          },
          optionalCrop: {
            type: "object",
            additionalProperties: false,
            required: ["type", "scale", "xPercent", "yPercent", "reason"],
            properties: {
              type: {
                type: "string",
                enum: ["none", "subtle_zoom"],
                description:
                  "Use subtle_zoom only for static wide shots where it will not hide hands or machine reference points.",
              },
              scale: {
                type: "number",
                minimum: 1,
                maximum: 1.12,
                description: "1 for no crop, or a subtle zoom scale.",
              },
              xPercent: {
                type: "number",
                minimum: -20,
                maximum: 20,
                description:
                  "Horizontal crop bias. 0 keeps the source centered.",
              },
              yPercent: {
                type: "number",
                minimum: -20,
                maximum: 20,
                description:
                  "Vertical crop bias. 0 keeps the source centered.",
              },
              reason: {
                type: "string",
                description: "Short reason for using or avoiding crop.",
              },
            },
          },
        },
      },
    },
    warnings: {
      type: "array",
      items: { type: "string" },
      description: "Overlay planning caveats, or an empty array.",
    },
  },
} as const;

function fail(message: string): never {
  throw new InstructionOverlayPlanValidationError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function roundSeconds(value: number) {
  return Math.round(value * 100) / 100;
}

function validateSafeString(value: unknown, fieldName: string, maxLength: number) {
  if (typeof value !== "string") {
    fail(`${fieldName} must be a string`);
  }

  const trimmed = value.trim();

  if (!trimmed) {
    fail(`${fieldName} must not be empty`);
  }

  if (trimmed.length > maxLength) {
    fail(`${fieldName} must be ${maxLength} characters or fewer`);
  }

  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(trimmed)) {
    fail(`${fieldName} contains control characters`);
  }

  if (/<\s*\/?\s*[a-z][^>]*>/i.test(trimmed) || /\bon[a-z]+\s*=/i.test(trimmed)) {
    fail(`${fieldName} contains unsafe markup-like text`);
  }

  return trimmed;
}

function validateNumber(value: unknown, fieldName: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${fieldName} must be a finite number`);
  }

  return roundSeconds(value);
}

function validateSegmentReference(
  segment: EditPlanSegmentReference,
  fieldName: string
) {
  if (
    !Number.isInteger(segment.segmentIndex) ||
    segment.segmentIndex <= 0 ||
    !Number.isFinite(segment.sourceStart) ||
    !Number.isFinite(segment.sourceEnd) ||
    segment.sourceEnd <= segment.sourceStart
  ) {
    fail(`${fieldName} is not a valid edit-plan segment reference`);
  }
}

function validateTransition(
  value: unknown,
  fieldName: string,
  isLastSegment: boolean
): InstructionOverlayTransition {
  if (!isRecord(value)) {
    fail(`${fieldName} must be an object`);
  }

  const type = value.type;
  const durationFrames = value.durationFrames;

  if (type !== "hard_cut" && type !== "fade") {
    fail(`${fieldName}.type must be hard_cut or fade`);
  }

  if (
    typeof durationFrames !== "number" ||
    !Number.isInteger(durationFrames) ||
    durationFrames < 0 ||
    durationFrames > 10
  ) {
    fail(`${fieldName}.durationFrames must be an integer from 0 to 10`);
  }

  if (type === "hard_cut" && durationFrames !== 0) {
    fail(`${fieldName}.durationFrames must be 0 for hard_cut`);
  }

  if (type === "fade" && (durationFrames < 6 || durationFrames > 10)) {
    fail(`${fieldName}.durationFrames must be 6-10 for fade`);
  }

  if (isLastSegment && (type !== "hard_cut" || durationFrames !== 0)) {
    fail(`${fieldName} must be a zero-frame hard_cut on the last segment`);
  }

  return {
    type,
    durationFrames,
    reason: validateSafeString(value.reason, `${fieldName}.reason`, 240),
  };
}

function validateOptionalCrop(
  value: unknown,
  fieldName: string
): InstructionOverlayOptionalCrop {
  if (!isRecord(value)) {
    fail(`${fieldName} must be an object`);
  }

  const type = value.type;
  const scale = validateNumber(value.scale, `${fieldName}.scale`);
  const xPercent = validateNumber(value.xPercent, `${fieldName}.xPercent`);
  const yPercent = validateNumber(value.yPercent, `${fieldName}.yPercent`);

  if (type !== "none" && type !== "subtle_zoom") {
    fail(`${fieldName}.type must be none or subtle_zoom`);
  }

  if (scale < 1 || scale > 1.12) {
    fail(`${fieldName}.scale must be between 1 and 1.12`);
  }

  if (type === "none" && scale !== 1) {
    fail(`${fieldName}.scale must be 1 when crop type is none`);
  }

  if (type === "subtle_zoom" && scale <= 1) {
    fail(`${fieldName}.scale must be greater than 1 for subtle_zoom`);
  }

  if (xPercent < -20 || xPercent > 20 || yPercent < -20 || yPercent > 20) {
    fail(`${fieldName} crop bias must stay between -20 and 20 percent`);
  }

  return {
    type,
    scale,
    xPercent,
    yPercent,
    reason: validateSafeString(value.reason, `${fieldName}.reason`, 240),
  };
}

export function validateInstructionOverlayPlan(
  value: unknown,
  options: {
    selectedSegments: EditPlanSegmentReference[];
    targetLanguage: string;
  }
): InstructionOverlayPlan {
  if (!isRecord(value)) {
    fail("Instruction overlay plan must be an object");
  }

  if (value.style !== "instruction_overlay") {
    fail("Instruction overlay plan style must be instruction_overlay");
  }

  const targetLanguage = validateSafeString(
    value.targetLanguage,
    "targetLanguage",
    80
  );

  if (
    targetLanguage.trim().toLowerCase() !==
    options.targetLanguage.trim().toLowerCase()
  ) {
    fail("Instruction overlay plan targetLanguage did not match request");
  }

  const rawSegments = value.segments;

  if (!Array.isArray(rawSegments) || rawSegments.length === 0) {
    fail("Instruction overlay plan must contain at least one segment");
  }

  if (rawSegments.length !== options.selectedSegments.length) {
    fail("Instruction overlay plan must include one segment per edit segment");
  }

  const selectedByIndex = new Map<number, EditPlanSegmentReference>();

  options.selectedSegments.forEach((segment, index) => {
    validateSegmentReference(segment, `selectedSegments[${index}]`);
    selectedByIndex.set(segment.segmentIndex, segment);
  });

  const seenSegmentIndexes = new Set<number>();
  const segments = rawSegments.map((segment, index) => {
    const fieldName = `segments[${index}]`;

    if (!isRecord(segment)) {
      fail(`${fieldName} must be an object`);
    }

    const segmentIndex = segment.segmentIndex;

    if (
      typeof segmentIndex !== "number" ||
      !Number.isInteger(segmentIndex) ||
      segmentIndex <= 0
    ) {
      fail(`${fieldName}.segmentIndex must be a positive integer`);
    }

    if (seenSegmentIndexes.has(segmentIndex)) {
      fail(`${fieldName}.segmentIndex must be unique`);
    }

    seenSegmentIndexes.add(segmentIndex);

    const selectedSegment = selectedByIndex.get(segmentIndex);

    if (!selectedSegment) {
      fail(`${fieldName}.segmentIndex must reference a selected edit segment`);
    }

    const sourceDurationSeconds = roundSeconds(
      selectedSegment.sourceEnd - selectedSegment.sourceStart
    );
    const holdAfterActionSeconds = validateNumber(
      segment.holdAfterActionSeconds,
      `${fieldName}.holdAfterActionSeconds`
    );

    if (holdAfterActionSeconds < 0 || holdAfterActionSeconds > 1.2) {
      fail(`${fieldName}.holdAfterActionSeconds must be between 0 and 1.2`);
    }

    const captionStart = validateNumber(segment.captionStart, `${fieldName}.captionStart`);
    const captionEnd = validateNumber(segment.captionEnd, `${fieldName}.captionEnd`);
    const maxCaptionEnd = sourceDurationSeconds + holdAfterActionSeconds;

    if (captionStart < 0 || captionStart >= captionEnd) {
      fail(`${fieldName} must have captionStart before captionEnd`);
    }

    if (captionEnd > maxCaptionEnd + 0.01) {
      fail(`${fieldName}.captionEnd exceeds the segment plus hold duration`);
    }

    return {
      segmentIndex,
      overlayCaption: validateSafeString(
        segment.overlayCaption,
        `${fieldName}.overlayCaption`,
        180
      ),
      captionStart,
      captionEnd,
      holdAfterActionSeconds,
      transitionToNext: validateTransition(
        segment.transitionToNext,
        `${fieldName}.transitionToNext`,
        index === rawSegments.length - 1
      ),
      optionalCrop: validateOptionalCrop(
        segment.optionalCrop,
        `${fieldName}.optionalCrop`
      ),
    };
  });

  const warnings = Array.isArray(value.warnings)
    ? value.warnings.map((warning, index) =>
        validateSafeString(warning, `warnings[${index}]`, 300)
      )
    : fail("Instruction overlay plan warnings must be an array");

  return {
    style: "instruction_overlay",
    targetLanguage,
    segments,
    warnings,
  };
}

export function getSelectedSegmentReferences(
  editPlan: Record<string, unknown>
): EditPlanSegmentReference[] {
  const segments = editPlan.segments;

  if (!Array.isArray(segments)) {
    return [];
  }

  return segments.flatMap((segment): EditPlanSegmentReference[] => {
    if (!isRecord(segment)) {
      return [];
    }

    const segmentIndex = segment.segmentIndex;
    const sourceStart = segment.sourceStart;
    const sourceEnd = segment.sourceEnd;

    if (
      typeof segmentIndex !== "number" ||
      typeof sourceStart !== "number" ||
      typeof sourceEnd !== "number"
    ) {
      return [];
    }

    return [
      {
        segmentIndex,
        sourceStart,
        sourceEnd,
      },
    ];
  });
}

export function buildInstructionOverlayRenderPlan(options: {
  selectedSegments: EditPlanSegmentReference[];
  overlayPlan: InstructionOverlayPlan;
}): InstructionOverlayRenderPlan {
  const overlayBySegmentIndex = new Map(
    options.overlayPlan.segments.map((segment) => [segment.segmentIndex, segment])
  );
  const renderSegments: InstructionOverlayRenderSegment[] = [];
  const cues: InstructionOverlayRenderCue[] = [];
  let cursorSeconds = 0;

  for (const selectedSegment of options.selectedSegments) {
    const overlaySegment = overlayBySegmentIndex.get(
      selectedSegment.segmentIndex
    );

    if (!overlaySegment) {
      fail(
        `Missing overlay segment for edit segment ${selectedSegment.segmentIndex}`
      );
    }

    const sourceDurationSeconds = roundSeconds(
      selectedSegment.sourceEnd - selectedSegment.sourceStart
    );
    const renderStartSeconds = cursorSeconds;
    const renderEndSeconds = roundSeconds(
      renderStartSeconds +
        sourceDurationSeconds +
        overlaySegment.holdAfterActionSeconds
    );

    renderSegments.push({
      segmentIndex: selectedSegment.segmentIndex,
      sourceStart: selectedSegment.sourceStart,
      sourceEnd: selectedSegment.sourceEnd,
      sourceDurationSeconds,
      holdAfterActionSeconds: overlaySegment.holdAfterActionSeconds,
      renderStartSeconds,
      renderEndSeconds,
      optionalCrop: overlaySegment.optionalCrop,
      transitionToNext: overlaySegment.transitionToNext,
    });

    cues.push({
      segmentIndex: selectedSegment.segmentIndex,
      text: overlaySegment.overlayCaption,
      startSeconds: roundSeconds(renderStartSeconds + overlaySegment.captionStart),
      endSeconds: roundSeconds(renderStartSeconds + overlaySegment.captionEnd),
    });

    cursorSeconds = renderEndSeconds;
  }

  return {
    segments: renderSegments,
    cues,
    durationSeconds: roundSeconds(cursorSeconds),
  };
}
