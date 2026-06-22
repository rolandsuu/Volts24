import assert from "node:assert/strict";
import test from "node:test";

import {
  InstructionDocumentValidationError,
  validateInstructionDocument,
  type InstructionDocument,
} from "./instruction-document.ts";

const frameReferences = [
  { index: 1, timestampSeconds: 0 },
  { index: 2, timestampSeconds: 4.5 },
  { index: 3, timestampSeconds: 9 },
];

function validDocument(
  overrides: Partial<InstructionDocument> = {}
): InstructionDocument {
  return {
    title: " Make a product demo ",
    overview: "This guide explains the upload flow.",
    targetLanguage: "zh",
    steps: [
      {
        stepIndex: 1,
        title: "Open the upload screen",
        instruction: "Choose the source video and confirm the prompt.",
        cautions: ["Confirm the selected video is the intended source file."],
        timestampSeconds: 4.5,
        sourceStartSeconds: 3,
        sourceEndSeconds: 6,
        keyFrame: {
          visualFrameIndex: 2,
          timestampSeconds: 4.5,
          altText: "The upload controls are visible.",
        },
      },
    ],
    checklist: [
      "Confirm every required file was selected.",
      "Confirm the prompt matches the desired output.",
      "Confirm the result is ready before sharing.",
    ],
    warnings: ["Frame sampling may miss very quick transitions."],
    ...overrides,
  };
}

function validate(value: unknown) {
  return validateInstructionDocument(value, {
    requestedTargetLanguage: "zh",
    sourceDurationSeconds: 12,
    frameReferences,
  });
}

test("validateInstructionDocument accepts and trims a valid document", () => {
  const document = validate(validDocument());

  assert.equal(document.title, "Make a product demo");
  assert.equal(document.targetLanguage, "zh");
  assert.equal(document.steps.length, 1);
  assert.equal(document.steps[0].cautions.length, 1);
  assert.equal(document.checklist.length, 3);
  assert.equal(document.steps[0].keyFrame.visualFrameIndex, 2);
});

test("validateInstructionDocument rejects missing required fields", () => {
  const document = validDocument();
  const withoutTitle: Partial<InstructionDocument> = { ...document };
  delete withoutTitle.title;

  assert.throws(
    () => validate(withoutTitle),
    InstructionDocumentValidationError
  );
});

test("validateInstructionDocument rejects empty steps", () => {
  assert.throws(
    () => validate(validDocument({ steps: [] })),
    /steps must contain at least one step/
  );
});

test("validateInstructionDocument rejects empty step cautions", () => {
  assert.throws(
    () =>
      validate(
        validDocument({
          steps: [
            {
              ...validDocument().steps[0],
              cautions: [],
            },
          ],
        })
      ),
    /cautions must contain at least 1 item/
  );
});

test("validateInstructionDocument rejects short final checklists", () => {
  assert.throws(
    () => validate(validDocument({ checklist: ["Confirm the result."] })),
    /checklist must contain at least 3 item/
  );
});

test("validateInstructionDocument rejects a mismatched target language", () => {
  assert.throws(
    () => validate(validDocument({ targetLanguage: "en" })),
    /targetLanguage must match/
  );
});

test("validateInstructionDocument rejects invalid timestamps", () => {
  assert.throws(
    () =>
      validate(
        validDocument({
          steps: [
            {
              ...validDocument().steps[0],
              timestampSeconds: 20,
            },
          ],
        })
      ),
    /timestampSeconds must be inside the source video duration/
  );
});

test("validateInstructionDocument rejects unknown frame references", () => {
  assert.throws(
    () =>
      validate(
        validDocument({
          steps: [
            {
              ...validDocument().steps[0],
              keyFrame: {
                ...validDocument().steps[0].keyFrame,
                visualFrameIndex: 99,
              },
            },
          ],
        })
      ),
    /references an unknown frame/
  );
});

test("validateInstructionDocument rejects unsafe strings", () => {
  assert.throws(
    () => validate(validDocument({ overview: "<script>alert(1)</script>" })),
    /unsafe markup-like text/
  );
});

test("validateInstructionDocument rejects unsafe customer cautions", () => {
  assert.throws(
    () =>
      validate(
        validDocument({
          steps: [
            {
              ...validDocument().steps[0],
              cautions: ["Click <button>Start</button>."],
            },
          ],
        })
      ),
    /unsafe markup-like text/
  );
});
