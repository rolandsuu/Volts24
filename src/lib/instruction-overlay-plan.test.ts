import assert from "node:assert/strict";
import test from "node:test";

import {
  buildInstructionOverlayRenderPlan,
  validateInstructionOverlayPlan,
} from "./instruction-overlay-plan.ts";

const selectedSegments = [
  {
    segmentIndex: 1,
    sourceStart: 10,
    sourceEnd: 14,
  },
  {
    segmentIndex: 2,
    sourceStart: 20,
    sourceEnd: 23,
  },
];

test("validateInstructionOverlayPlan accepts one overlay per selected segment", () => {
  const plan = validateInstructionOverlayPlan(
    {
      style: "instruction_overlay",
      targetLanguage: "English",
      segments: [
        {
          segmentIndex: 1,
          overlayCaption: "Next, loosen the knob and raise the sensor bracket.",
          captionStart: 0.2,
          captionEnd: 3.8,
          holdAfterActionSeconds: 0.5,
          transitionToNext: {
            type: "hard_cut",
            durationFrames: 0,
            reason: "The next shot continues the same setup.",
          },
          optionalCrop: {
            type: "none",
            scale: 1,
            xPercent: 0,
            yPercent: 0,
            reason: "Hands and reference points already fill the frame.",
          },
        },
        {
          segmentIndex: 2,
          overlayCaption: "Tighten the screw once the sensor reaches the top.",
          captionStart: 0.1,
          captionEnd: 3.3,
          holdAfterActionSeconds: 0.4,
          transitionToNext: {
            type: "hard_cut",
            durationFrames: 0,
            reason: "Last selected step.",
          },
          optionalCrop: {
            type: "subtle_zoom",
            scale: 1.04,
            xPercent: 0,
            yPercent: -4,
            reason: "The shot is wide but the machine reference remains visible.",
          },
        },
      ],
      warnings: [],
    },
    {
      selectedSegments,
      targetLanguage: "English",
    }
  );

  assert.equal(plan.segments.length, 2);
  assert.equal(plan.segments[1].optionalCrop.type, "subtle_zoom");
});

test("buildInstructionOverlayRenderPlan converts segment-relative captions to render timeline", () => {
  const overlayPlan = validateInstructionOverlayPlan(
    {
      style: "instruction_overlay",
      targetLanguage: "English",
      segments: [
        {
          segmentIndex: 1,
          overlayCaption: "Raise the sensor bracket to its highest position.",
          captionStart: 0.25,
          captionEnd: 4.3,
          holdAfterActionSeconds: 0.5,
          transitionToNext: {
            type: "hard_cut",
            durationFrames: 0,
            reason: "Direct procedural cut.",
          },
          optionalCrop: {
            type: "none",
            scale: 1,
            xPercent: 0,
            yPercent: 0,
            reason: "No crop needed.",
          },
        },
        {
          segmentIndex: 2,
          overlayCaption: "Check the final alignment before continuing.",
          captionStart: 0,
          captionEnd: 2.8,
          holdAfterActionSeconds: 0.4,
          transitionToNext: {
            type: "hard_cut",
            durationFrames: 0,
            reason: "Last selected step.",
          },
          optionalCrop: {
            type: "none",
            scale: 1,
            xPercent: 0,
            yPercent: 0,
            reason: "No crop needed.",
          },
        },
      ],
      warnings: [],
    },
    {
      selectedSegments,
      targetLanguage: "English",
    }
  );

  const renderPlan = buildInstructionOverlayRenderPlan({
    selectedSegments,
    overlayPlan,
  });

  assert.equal(renderPlan.durationSeconds, 7.9);
  assert.deepEqual(renderPlan.cues.map((cue) => cue.startSeconds), [0.25, 4.5]);
  assert.deepEqual(renderPlan.cues.map((cue) => cue.endSeconds), [4.3, 7.3]);
});

test("validateInstructionOverlayPlan rejects missing edit segments", () => {
  assert.throws(
    () =>
      validateInstructionOverlayPlan(
        {
          style: "instruction_overlay",
          targetLanguage: "English",
          segments: [
            {
              segmentIndex: 1,
              overlayCaption: "Raise the sensor bracket to its highest position.",
              captionStart: 0,
              captionEnd: 2,
              holdAfterActionSeconds: 0.5,
              transitionToNext: {
                type: "hard_cut",
                durationFrames: 0,
                reason: "Only one segment was returned.",
              },
              optionalCrop: {
                type: "none",
                scale: 1,
                xPercent: 0,
                yPercent: 0,
                reason: "No crop needed.",
              },
            },
          ],
          warnings: [],
        },
        {
          selectedSegments,
          targetLanguage: "English",
        }
      ),
    /one segment per edit segment/
  );
});
