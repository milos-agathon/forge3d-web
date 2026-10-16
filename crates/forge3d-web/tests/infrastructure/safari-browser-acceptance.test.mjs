import assert from "node:assert/strict";
import test from "node:test";

import { runSafariBrowserAcceptance } from "../../scripts/safari-browser-acceptance.mjs";

test("Safari acceptance drives bounded W3C input and thirty true BFCache returns", async () => {
  const session = new FakeSafariSession();
  const payload = {
    binding: { lane: "safari-macos-m2", assetId: "FW-MAC-M2-01",
      commit: "a".repeat(40), packageSha256: "b".repeat(64) },
    route: { applicationUrl: `https://mac-m2.webgpu-ci.forge3d.dev/runs/1/2/${"c".repeat(32)}/` },
  };
  const result = await runSafariBrowserAcceptance(session, payload);
  assert.equal(result.saf04Proof.lifecycle.bfcacheCycles.length, 30);
  assert.equal(session.navigations.length, 30);
  assert.equal(session.backCalls, 30);
  assert.equal(session.refreshCalls, 1);
  assert.equal(session.actions.every((sources) => sources.length <= 4 && Math.max(...sources.map((source) => source.actions.length)) <= 64), true);
  assert.equal(result.saf04Proof.layout.displayNoneCycles.length, 30);
  assert.equal(result.saf04Proof.layout.zeroParentCycles.length, 30);
  assert.deepEqual(new Set([
    result.saf04Proof.controls.pointer.pointerId,
    result.saf04Proof.controls.pointer.capturedPointerId,
    result.saf04Proof.controls.pointer.outsidePointerId,
    result.saf04Proof.controls.pointer.continuedPointerId,
    result.saf04Proof.controls.pointer.releasedPointerId,
  ]).size, 1);
  assert.deepEqual(result.saf04Proof.controls.gestureListeners,
    { targets: ["canvas", "document", "window"], whileLive: 0, afterDispose: 0, everAdded: 0 });
  assert.equal(result.saf04Proof.controls.keyboardReset.matchesInitial, true);
  assert.equal(result.saf04Proof.layout.browserZoom.submittedDelta > 0, true);
  assert.equal(result.saf04Proof.layout.browserZoom.resetSubmittedDelta > 0, true);
  assert.equal(result.saf04Proof.lifecycle.bfcacheCycles.every((cycle) =>
    cycle.postReturnInputChanged && cycle.postReturnSubmittedDelta > 0 && cycle.recoveryAttempts === 0), true);
});

test("Safari BFCache acceptance rejects a restored viewer whose controls do not respond", async () => {
  const session = new FakeSafariSession({ controlsResponsive: false });
  await assert.rejects(() => runSafariBrowserAcceptance(session, {
    binding: { lane: "safari-macos-m2", assetId: "FW-MAC-M2-01",
      commit: "a".repeat(40), packageSha256: "b".repeat(64) },
    route: { applicationUrl: `https://mac-m2.webgpu-ci.forge3d.dev/runs/1/2/${"c".repeat(32)}/` },
  }));
});

test("Safari acceptance rejects a complete second input-controller listener set added after initialization", async () => {
  const session = new FakeSafariSession({ secondControllerAfterInitialization: true });
  await assert.rejects(() => runSafariBrowserAcceptance(session, {
    binding: { lane: "safari-macos-m2", assetId: "FW-MAC-M2-01",
      commit: "a".repeat(40), packageSha256: "b".repeat(64) },
    route: { applicationUrl: `https://mac-m2.webgpu-ci.forge3d.dev/runs/1/2/${"c".repeat(32)}/` },
  }));
});

class FakeSafariSession {
  actions = [];
  navigations = [];
  backCalls = 0;
  refreshCalls = 0;
  dpr = 2;
  viewVersion = 0;
  controlsResponsive;
  inputControllerSets;

  constructor({ controlsResponsive = true, secondControllerAfterInitialization = false } = {}) {
    this.controlsResponsive = controlsResponsive;
    this.inputControllerSets = secondControllerAfterInitialization ? 2 : 1;
  }

  async runHardwarePage() {
    return { adapter: { deviceCreated: true }, assertions: { passed: true } };
  }

  async findElement(selector) { return selector === "body" ? "body" : "canvas"; }
  async elementRect() { return { x: 10, y: 20, width: 320, height: 320 }; }
  async releaseActions() {}
  async navigate(url) { this.navigations.push(url); }
  async back() { this.backCalls += 1; }
  async refresh() { this.refreshCalls += 1; }

  async performActions(sources) {
    this.actions.push(sources);
    const id = sources[0].id;
    if (["safari-pointer-capture", "safari-pointer-2", "safari-wheel"].includes(id)) this.viewVersion += 1;
    if (id === "safari-keys") this.viewVersion = 0;
    if (id.startsWith("safari-bfcache-key-") && this.controlsResponsive) this.viewVersion += 1;
    if (id === "safari-browser-zoom") this.dpr = 1.8;
    if (id === "safari-browser-zoom-reset") this.dpr = 2;
  }

  async executeAsync(script) {
    if (script.includes("displayNoneCycles")) {
      const cycle = (index) => ({ cycle: index + 1, hiddenSubmittedDelta: 0, recovered: true,
        activeObservers: 1, activeRuntimes: 1, pendingAnimationFrame: false, ownedAnimationFrameCount: 0 });
      return { ok: true, value: {
        displayNoneCycles: Array.from({ length: 30 }, (_, index) => cycle(index)),
        zeroParentCycles: Array.from({ length: 30 }, (_, index) => cycle(index)),
      } };
    }
    if (script.includes("postReturnInputChanged")) {
      const index = this.backCalls - 1;
      return { pagehideEventId: index * 2 + 2, pageshowEventId: index * 2 + 3,
        pagehideCount: index + 1, pageshowCount: index + 2,
        pagehidePersisted: true, pageshowPersisted: true, pagehideTrusted: true, pageshowTrusted: true,
        postNavigationIdentityStable: true, runtimeGeneration: 1, ownedListeners: 15,
        inputControllerSets: this.inputControllerSets,
        activeObservers: 1, activePointers: 0, activeRuntimes: 1, recoveryAttempts: 0,
        pendingAnimationFrame: false, ownedAnimationFrameCount: 0,
        postReturnInputChanged: this.controlsResponsive, postReturnSubmittedDelta: this.controlsResponsive ? 1 : 0 };
    }
    if (script.includes("devicePixelRatio") && script.includes("expected")) {
      return { dpr: 2, backingWidth: 640, backingHeight: 640, effectiveDpr: 2, submittedFrames: 12 };
    }
    if (script.includes("devicePixelRatio")) {
      return { dpr: 1.8, cssWidth: 320, cssHeight: 320, backingWidth: 576,
        backingHeight: 576, effectiveDpr: 1.8, submittedFrames: 11 };
    }
    return { ok: true };
  }

  async execute(script) {
    if (script.includes("capturedPointerId = null")) return null;
    if (script.includes("PointerEvent")) return { cancelledPointerId: 9,
      hasPointerCapture: false, activePointers: 0 };
    if (script.includes("return { pointerId: state.lastPointerId")) return { pointerId: 9,
      capturedPointerId: 9, trustedMovePointerId: 9, hasPointerCapture: true, activePointers: 1 };
    if (script.includes("trustedMovePointerId") && script.includes("releasedPointerId")) return {
      trustedMovePointerId: 9, releasedPointerId: 9, hasPointerCapture: false, activePointers: 0 };
    if (script.includes("outsidePointerId")) return { pointerId: 7, capturedPointerId: 7,
      outsidePointerId: 7, captured: true, outside: true, activePointers: 1, view: { version: this.viewVersion } };
    if (script.includes("continuedPointerId")) return { continuedPointerId: 7, captured: true,
      activePointers: 1, view: { version: this.viewVersion } };
    if (script.includes("releasedPointerId")) return { releasedPointerId: 7, captured: false, activePointers: 0 };
    if (script.includes("viewBefore")) {
      const index = this.backCalls - 1;
      return { viewBefore: { version: this.viewVersion }, submittedBefore: 10 + index,
        pagehideEventId: index * 2 + 2, pageshowEventId: index * 2 + 3,
        pagehideCount: index + 1, pageshowCount: index + 2,
        pagehidePersisted: true, pageshowPersisted: true, pagehideTrusted: true, pageshowTrusted: true,
        postNavigationIdentityStable: true, activeObservers: 1, activePointers: 0, activeRuntimes: 1 };
    }
    if (script.includes("canvas.focus")) return null;
    if (script.includes("getView")) return { version: this.viewVersion };
    if (script.includes("document.activeElement")) return { dpr: 2, cssWidth: 320, cssHeight: 320,
      backingWidth: 640, backingHeight: 640, effectiveDpr: 2, maxEffectiveDpr: 2,
      maxCanvasPixels: 8294400, maxTextureDimension2D: 8192, submittedFrames: 10 };
    if (script.includes("lifecycleIdentity =")) return { documentToken: "document-1", viewerToken: "viewer-1",
      canvasToken: "canvas-1", generation: 1, ownedListeners: 15,
      inputControllerSets: this.inputControllerSets, activeObservers: 1,
      activeRuntimes: 1, activePointers: 0, pagehideCount: 0, pageshowCount: 1 };
    if (script.includes("identity.document === document")) return true;
    if (script.includes("gestureSnapshot") && !script.includes("viewer.dispose")) return { active: 0, everAdded: 0 };
    if (script.includes("const generation =") && script.includes("viewer.dispose")) {
      return { generation: 1, gestureListeners: { active: 0, everAdded: 0 },
        contextMenuSuppressed: true, pointerReleased: true };
    }
    if (script.includes("__forge3dLifecycle.pageshow")) return false;
    if (script.includes("getDiagnostics().generation")) return 1;
    throw new Error(`unexpected execute script: ${script.slice(0, 60)}`);
  }
}
