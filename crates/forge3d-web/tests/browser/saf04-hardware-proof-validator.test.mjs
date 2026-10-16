import assert from "node:assert/strict";
import test from "node:test";

import { validateSaf04HardwareProof } from "../../scripts/saf04-hardware-proof-validator.mjs";
import { validSaf04HardwareProof } from "./saf04-hardware-proof-fixture.mjs";

test("SAF-04 proof validates the versioned exact binding and complete cycles", () => {
  const proof = validSaf04HardwareProof();
  assert.equal(validateSaf04HardwareProof(proof, proof.binding), proof);
});

test("SAF-04 proof rejects substitution, stale lifecycle, premature capture loss, no-op zoom, and transient Gesture Events", () => {
  for (const mutate of [
    (proof) => { proof.binding.packageSha256 = "c".repeat(64); },
    (proof) => { proof.layout.displayNoneCycles.pop(); },
    (proof) => { proof.lifecycle.bfcacheCycles[0].pageshowPersisted = false; },
    (proof) => { proof.controls.gestureListeners.everAdded = 1; },
    (proof) => { proof.lifecycle.generationAfter = 2; },
    (proof) => { proof.lifecycle.bfcacheCycles[1].pageshowEventId = proof.lifecycle.bfcacheCycles[0].pageshowEventId; },
    (proof) => { proof.lifecycle.bfcacheCycles[2].pagehideCount -= 1; },
    (proof) => { proof.lifecycle.bfcacheCycles[3].pagehideTrusted = false; },
    (proof) => { proof.lifecycle.bfcacheCycles[4].postNavigationIdentityStable = false; },
    (proof) => { proof.lifecycle.bfcacheCycles[5].preNavigationIdentityStable = false; },
    (proof) => { proof.lifecycle.bfcacheCycles[6].ownedListeners -= 1; },
    (proof) => { proof.lifecycle.bfcacheCycles[7].runtimeGeneration += 1; },
    (proof) => { proof.lifecycle.bfcacheCycles[8].postReturnSubmittedDelta = 0; },
    (proof) => { proof.controls.pointer.captureRetainedForFurtherMovement = false; },
    (proof) => { proof.controls.pointer.releasedPointerId += 1; },
    (proof) => { proof.controls.pointer.cancelReleasedPointerId += 1; },
    (proof) => { proof.controls.pointer.cancelHasPointerCapture = true; },
    (proof) => { proof.controls.pointer.cancelCaptureEstablished = false; },
    (proof) => { proof.controls.pointer.cancelImmediateHasPointerCapture = true; },
    (proof) => { proof.controls.pointer.cancelPostMovePointerId += 1; },
    (proof) => { proof.controls.keyboardReset.matchesInitial = false; },
    (proof) => { proof.layout.browserZoom.backingWidthAfter = proof.layout.browserZoom.backingWidthBefore;
      proof.layout.browserZoom.backingHeightAfter = proof.layout.browserZoom.backingHeightBefore; },
    (proof) => { proof.layout.browserZoom.resetBackingWidth -= 1; },
    (proof) => { proof.layout.browserZoom.effectiveDprAfter = 1.7; },
    (proof) => { proof.layout.browserZoom.backingWidthAfter = 1; proof.layout.browserZoom.backingHeightAfter = 1; },
    (proof) => { proof.layout.browserZoom.backingWidthAfter = 500; proof.layout.browserZoom.backingHeightAfter = 500; },
    (proof) => { proof.layout.browserZoom.backingWidthAfter = 576; proof.layout.browserZoom.backingHeightAfter = 500; },
    (proof) => { proof.layout.browserZoom.maxTextureDimension2D = 500; },
    (proof) => { proof.layout.browserZoom.maxCanvasPixels = 250000; },
    (proof) => { proof.lifecycle.baseline.inputControllerSets = 2; },
    (proof) => { proof.lifecycle.bfcacheCycles[10].inputControllerSets = 2; },
  ]) {
    const proof = validSaf04HardwareProof();
    mutate(proof);
    assert.throws(() => validateSaf04HardwareProof(proof, validSaf04HardwareProof().binding));
  }
});
