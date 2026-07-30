import { describe, expect, it } from "vitest";

import {
  isWebGpuValidationError,
  validateViewerInteractionObservation,
} from "../browser/viewer-interaction-observation.mjs";

describe("viewer interaction observation", () => {
  it("accepts a ten-second error-free RAF interaction run", () => {
    const observation = makeObservation();
    expect(validateViewerInteractionObservation(observation)).toBe(
      observation,
    );
  });

  it("rejects a short interaction run", () => {
    expect(() =>
      validateViewerInteractionObservation(
        makeObservation({ elapsedMs: 9_999 }),
      ),
    ).toThrow(/did not reach 10000ms/);
  });

  it("rejects an observed viewer or WebGPU validation error", () => {
    expect(() =>
      validateViewerInteractionObservation(
        makeObservation({
          normalizedErrorCodes: ["INTERNAL_ERROR"],
        }),
      ),
    ).toThrow(/captured viewer or WebGPU validation errors/);
  });

  it("rejects missing render activity", () => {
    expect(() =>
      validateViewerInteractionObservation(
        makeObservation({ submittedFramesDelta: 599 }),
      ),
    ).toThrow(/did not continuously render/);
  });
});

describe("WebGPU validation error observation", () => {
  for (const message of [
    "GPUValidationError: render pipeline is invalid",
    "WebGPU validation error while encoding the render pass",
    "wgpu: buffer validation failed",
    "Validation Error: command submission rejected by the GPU",
  ]) {
    it(`recognizes ${message}`, () => {
      expect(isWebGpuValidationError(message)).toBe(true);
    });
  }

  for (const message of [
    "Form validation error: email is required",
    "Schema validation failed for the release document",
    "WebGPU adapter selected successfully",
    "GPU process started without errors",
  ]) {
    it(`ignores ${message}`, () => {
      expect(isWebGpuValidationError(message)).toBe(false);
    });
  }
});

function makeObservation(overrides = {}) {
  return {
    kind: "forge3d-viewer-interaction-observation-v1",
    minimumDurationMs: 10_000,
    elapsedMs: 10_001,
    timingSource: "requestAnimationFrame",
    traceId: "forge3d-viewer-benchmark-trace-v1",
    traceSamplesApplied: 600,
    renderRequestsDelta: 600,
    submittedFramesDelta: 600,
    skippedFramesDelta: 0,
    normalizedErrorCodes: [],
    visibilityStateBefore: "visible",
    visibilityStateAfter: "visible",
    visibilityChangeCount: 0,
    viewerStatus: "ready",
    sameCanvas: true,
    viewChanged: true,
    physicalSupportEvidence: false,
    supportPromotionEligible: false,
    ...overrides,
  };
}
