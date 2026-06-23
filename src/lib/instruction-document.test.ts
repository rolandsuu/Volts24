import assert from "node:assert/strict";
import test from "node:test";

import {
  INSTRUCTION_DOCUMENT_SCHEMA,
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
    safetyPrecautions: [
      "Ensure the work area is clean and free of obstructions.",
      "Wear approved safety equipment.",
    ],
    requiredToolsAndComponents: ["Laptop", "Power cable"],
    finalInspectionChecklist: [
      "Confirm every required file was selected.",
      "Confirm the prompt matches the desired output.",
      "Confirm the result is ready before sharing.",
    ],
    maintenanceRecommendations: ["Close and lock all access panels after completion."],
    steps: [
      {
        stepIndex: 1,
        title: "Open the upload screen",
        purpose: "Prepare the source and settings for upload.",
        procedure:
          "Choose the source video and confirm the prompt. Do not proceed until both are correct.",
        inspectionCriteria: [
          "The correct file is visible in source selection.",
          "The target outcome text matches your requirement.",
        ],
        importantNotes: [
          "You can restart this step if the preview appears incorrect.",
        ],
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
    ...overrides,
  };
}

function validate(value: unknown, requestedTargetLanguage = "zh") {
  return validateInstructionDocument(value, {
    requestedTargetLanguage,
    sourceDurationSeconds: 12,
    frameReferences,
  });
}

function assertOpenAiStrictSchema(schema: unknown, path = "schema") {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return;
  }

  const schemaRecord = schema as Record<string, unknown>;

  if (
    schemaRecord.type === "object" &&
    schemaRecord.properties &&
    typeof schemaRecord.properties === "object" &&
    !Array.isArray(schemaRecord.properties)
  ) {
    const properties = schemaRecord.properties as Record<string, unknown>;
    const propertyKeys = Object.keys(properties);

    assert.equal(
      schemaRecord.additionalProperties,
      false,
      `${path}.additionalProperties must be false`
    );
    assert.ok(Array.isArray(schemaRecord.required), `${path}.required must be an array`);

    const required = schemaRecord.required as unknown[];

    for (const key of propertyKeys) {
      assert.ok(
        required.includes(key),
        `${path}.required must include properties.${key}`
      );
    }

    for (const key of required) {
      if (typeof key !== "string") {
        assert.fail(`${path}.required entries must be strings`);
      }

      assert.ok(
        propertyKeys.includes(key),
        `${path}.required contains unknown key ${String(key)}`
      );
    }

    for (const [key, propertySchema] of Object.entries(properties)) {
      assertOpenAiStrictSchema(propertySchema, `${path}.properties.${key}`);
    }
  }

  if (schemaRecord.type === "array") {
    assertOpenAiStrictSchema(schemaRecord.items, `${path}.items`);
  }
}

test("INSTRUCTION_DOCUMENT_SCHEMA satisfies OpenAI strict object requirements", () => {
  assertOpenAiStrictSchema(INSTRUCTION_DOCUMENT_SCHEMA);
});

test("validateInstructionDocument accepts and trims a valid document", () => {
  const document = validate(validDocument());

  assert.equal(document.title, "Make a product demo");
  assert.equal(document.targetLanguage, "zh");
  assert.equal(document.steps.length, 1);
  assert.equal(document.steps[0].inspectionCriteria.length, 2);
  assert.equal(document.finalInspectionChecklist.length, 3);
  assert.equal(document.maintenanceRecommendations.length, 1);
  assert.equal(document.steps[0].keyFrame.visualFrameIndex, 2);
});

test("validateInstructionDocument accepts a valid English document", () => {
  const document = validate(
    validDocument({
      title: "Machine start-up checklist",
      overview: "This guide explains safe startup procedures.",
      targetLanguage: "en",
      safetyPrecautions: ["Wear approved PPE before operation."],
      requiredToolsAndComponents: ["Torque wrench", "Inspection light"],
      finalInspectionChecklist: [
        "Verify safety interlocks are active.",
        "Confirm startup flow is complete.",
        "Log operator and shift completion time.",
      ],
      maintenanceRecommendations: ["Close the access panel after startup checks."],
      steps: [
        {
          ...validDocument().steps[0],
          title: "Inspect startup panel",
          purpose: "Ensure controls are ready before power on.",
          procedure:
            "Check the panel indicators and confirm all selector switches are in the correct position.",
          inspectionCriteria: [
            "All warning lights are green.",
            "No selector switch is in emergency reset.",
          ],
          importantNotes: ["Pause if any gauge oscillates beyond expected range."],
          timestampSeconds: 0,
          sourceStartSeconds: 0,
          sourceEndSeconds: 2,
          keyFrame: {
            ...validDocument().steps[0].keyFrame,
            visualFrameIndex: 1,
            timestampSeconds: 0,
          },
        },
      ],
    }),
    "en"
  );

  assert.equal(document.targetLanguage, "en");
});

test("validateInstructionDocument rejects documents missing required manual sections", () => {
  const requiredFields: Array<keyof InstructionDocument> = [
    "overview",
    "safetyPrecautions",
    "requiredToolsAndComponents",
    "finalInspectionChecklist",
    "maintenanceRecommendations",
    "steps",
  ];

  for (const field of requiredFields) {
    const withoutField = validDocument() as Record<string, unknown>;
    delete withoutField[field];

    assert.throws(
      () => validate(withoutField),
      InstructionDocumentValidationError
    );
  }
});

test("validateInstructionDocument allows optional empty important notes", () => {
  const document = validate(
    validDocument({
      steps: [
        {
          ...validDocument().steps[0],
          importantNotes: [],
        },
      ],
    })
  );

  assert.equal(document.steps[0].importantNotes.length, 0);
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

test("validateInstructionDocument rejects empty inspectionCriteria", () => {
  assert.throws(
    () =>
      validate(
        validDocument({
          steps: [
            {
              ...validDocument().steps[0],
              inspectionCriteria: [],
            },
          ],
        })
      ),
    /inspectionCriteria must contain at least 1 item/
  );
});

test("validateInstructionDocument rejects short finalInspectionChecklist", () => {
  assert.throws(
    () => validate(validDocument({ finalInspectionChecklist: ["Confirm the result."] })),
    /finalInspectionChecklist must contain at least 3 item/
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
              inspectionCriteria: ["Click <button>Start</button>."],
            },
          ],
        })
      ),
    /unsafe markup-like text/
  );
});
