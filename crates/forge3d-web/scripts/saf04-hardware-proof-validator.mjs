import { existsSync, readFileSync } from "node:fs";

import { assertJsonSchema } from "./json-schema-validator.mjs";

const sourceSchema = new URL("../tests/browser/saf04-hardware-proof.schema.json", import.meta.url);
const packagedSchema = new URL("./saf04-hardware-proof.schema.json", import.meta.url);
const schema = JSON.parse(readFileSync(existsSync(packagedSchema) ? packagedSchema : sourceSchema, "utf8"));

export function validateSaf04HardwareProof(proof, expectedBinding = null) {
  assertJsonSchema(proof, schema);
  if (expectedBinding !== null) {
    for (const field of ["lane", "assetId", "commit", "packageSha256"]) {
      if (proof.binding[field] !== expectedBinding[field]) {
        throw new Error(`SAF-04 proof ${field} does not match the authorized binding`);
      }
    }
  }
  const layoutCycles = [proof.layout.displayNoneCycles, proof.layout.zeroParentCycles];
  for (const cycles of layoutCycles) assertSequentialCycles(cycles, "SAF-04 layout");
  assertSequentialCycles(proof.lifecycle.bfcacheCycles, "SAF-04 BFCache");
  assertPointerContinuity(proof.controls.pointer);
  if (JSON.stringify(proof.controls.gestureListeners.targets) !== JSON.stringify(["canvas", "document", "window"])) {
    throw new Error("SAF-04 Gesture Event listener measurement did not cover every relevant target");
  }
  assertBrowserZoom(proof.layout.browserZoom);
  assertBfcacheContinuity(proof.lifecycle);
  if (proof.lifecycle.generationBefore !== proof.lifecycle.generationAfter) {
    throw new Error("SAF-04 lifecycle recreated the runtime without DEVICE_LOST");
  }
  return proof;
}

function assertPointerContinuity(pointer) {
  const ids = [pointer.pointerId, pointer.capturedPointerId, pointer.outsidePointerId,
    pointer.continuedPointerId, pointer.releasedPointerId];
  if (!ids.every((id) => id === ids[0])) {
    throw new Error("SAF-04 pointer capture proof does not track one pointer through release");
  }
  if (pointer.cancelledPointerId !== pointer.cancelCapturedPointerId ||
      pointer.cancelledPointerId !== pointer.cancelEstablishMovePointerId ||
      pointer.cancelledPointerId !== pointer.cancelPostMovePointerId ||
      pointer.cancelledPointerId !== pointer.cancelReleasedPointerId || pointer.cancelHasPointerCapture !== false ||
      pointer.cancelImmediateHasPointerCapture !== false || pointer.cancelImmediateActivePointers !== 0) {
    throw new Error("SAF-04 pointercancel did not release capture for the cancelled pointer");
  }
}

function assertBrowserZoom(zoom) {
  if (zoom.dprBefore === zoom.dprAfter || Number.isInteger(zoom.dprAfter)) {
    throw new Error("SAF-04 browser zoom did not produce a fractional DPR change");
  }
  if (zoom.cssWidthBefore !== zoom.cssWidthAfter || zoom.cssHeightBefore !== zoom.cssHeightAfter) {
    throw new Error("SAF-04 browser zoom changed the CSS canvas size");
  }
  if (zoom.backingWidthBefore === zoom.backingWidthAfter && zoom.backingHeightBefore === zoom.backingHeightAfter) {
    throw new Error("SAF-04 browser zoom did not resize the backing canvas");
  }
  if (zoom.effectiveDprAfter > zoom.maxEffectiveDpr ||
      zoom.backingWidthAfter * zoom.backingHeightAfter > zoom.maxCanvasPixels) {
    throw new Error("SAF-04 browser zoom exceeded the viewer resize policy");
  }
  const policy = { maxDevicePixelRatio: zoom.maxEffectiveDpr, maxCanvasPixels: zoom.maxCanvasPixels,
    maxTextureDimension2D: zoom.maxTextureDimension2D };
  const expectedBefore = computeExpectedBacking(zoom.cssWidthBefore, zoom.cssHeightBefore, zoom.dprBefore, policy);
  const expectedAfter = computeExpectedBacking(zoom.cssWidthAfter, zoom.cssHeightAfter, zoom.dprAfter, policy);
  for (const [label, expected, width, height, effective] of [
    ["initial", expectedBefore, zoom.backingWidthBefore, zoom.backingHeightBefore, zoom.effectiveDprBefore],
    ["zoomed", expectedAfter, zoom.backingWidthAfter, zoom.backingHeightAfter, zoom.effectiveDprAfter],
    ["reset", expectedBefore, zoom.resetBackingWidth, zoom.resetBackingHeight, zoom.resetEffectiveDpr],
  ]) {
    if (width !== expected.width || height !== expected.height || Math.abs(effective - expected.effective) >= 1e-9) {
      throw new Error(`SAF-04 ${label} backing size does not match the shared resize policy`);
    }
  }
  if (zoom.resetDpr !== zoom.dprBefore || zoom.resetBackingWidth !== zoom.backingWidthBefore ||
      zoom.resetBackingHeight !== zoom.backingHeightBefore || zoom.resetEffectiveDpr !== zoom.effectiveDprBefore) {
    throw new Error("SAF-04 browser zoom reset did not restore DPR and backing dimensions");
  }
}

function computeExpectedBacking(cssWidth, cssHeight, devicePixelRatio, policy) {
  const scale = Math.min(devicePixelRatio, policy.maxDevicePixelRatio,
    policy.maxTextureDimension2D / cssWidth, policy.maxTextureDimension2D / cssHeight,
    Math.sqrt(policy.maxCanvasPixels / (cssWidth * cssHeight)));
  let width = Math.min(Math.max(1, Math.floor(cssWidth * scale)), policy.maxTextureDimension2D);
  let height = Math.min(Math.max(1, Math.floor(cssHeight * scale)), policy.maxTextureDimension2D);
  while (width * height > policy.maxCanvasPixels) {
    if (width / cssWidth >= height / cssHeight && width > 1) width -= 1;
    else if (height > 1) height -= 1;
    else break;
  }
  return { width, height, effective: Math.min(width / cssWidth, height / cssHeight) };
}

function assertBfcacheContinuity(lifecycle) {
  const { baseline, bfcacheCycles } = lifecycle;
  if (lifecycle.generationBefore !== baseline.generation || lifecycle.generationAfter !== baseline.generation) {
    throw new Error("SAF-04 lifecycle generation does not match the pre-navigation baseline");
  }
  const eventIds = new Set();
  let priorEventId = 0;
  for (const [index, cycle] of bfcacheCycles.entries()) {
    if (cycle.pagehideCount !== baseline.pagehideCount + index + 1 ||
        cycle.pageshowCount !== baseline.pageshowCount + index + 1) {
      throw new Error("SAF-04 BFCache events were not freshly consumed once per cycle");
    }
    for (const eventId of [cycle.pagehideEventId, cycle.pageshowEventId]) {
      if (eventIds.has(eventId) || eventId <= priorEventId) {
        throw new Error("SAF-04 BFCache event identity is stale or duplicated");
      }
      eventIds.add(eventId);
      priorEventId = eventId;
    }
    if (cycle.runtimeGeneration !== baseline.generation || cycle.ownedListeners !== baseline.ownedListeners ||
        cycle.inputControllerSets !== baseline.inputControllerSets) {
      throw new Error("SAF-04 BFCache replaced the runtime or input-listener baseline");
    }
  }
}

function assertSequentialCycles(cycles, label) {
  if (!cycles.every((cycle, index) => cycle.cycle === index + 1)) {
    throw new Error(`${label} cycles are not complete and sequential`);
  }
}
