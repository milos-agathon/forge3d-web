import { validateSaf04HardwareProof } from "./saf04-hardware-proof-validator.mjs";

const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";
const META = "\uE03D";
const HOME = "\uE011";
const ARROW_RIGHT = "\uE014";

export async function runSafariBrowserAcceptance(session, payload) {
  if (payload?.binding?.lane !== "safari-macos-m2") {
    throw new Error("SAF-04 acceptance requires the authorized Safari lane");
  }
  const result = await session.runHardwarePage(payload);
  await initializeViewer(session);
  const canvasId = await session.findElement("#viewer");
  const canvasOrigin = { [ELEMENT_KEY]: canvasId };
  const rect = await session.elementRect(canvasId);
  const initial = await view(session);

  const pointerAcceptance = await runPointerCaptureAcceptance(session, canvasOrigin, rect, initial);
  const afterOrbit = pointerAcceptance.afterView;
  await pointerDrag(session, canvasOrigin, rect, 2, rect.x + rect.width / 2 + 40, rect.y + rect.height / 2 + 25);
  const afterPan = await view(session);
  await session.performActions([{ type: "wheel", id: "safari-wheel", actions: [
    { type: "scroll", origin: canvasOrigin, x: 0, y: 0, deltaX: 0, deltaY: -120, duration: 100 },
  ] }]);
  await session.releaseActions();
  const afterWheel = await view(session);
  await session.execute("window.__forge3dInteractiveViewer.canvas.focus();");
  await session.performActions([{ type: "key", id: "safari-keys", actions: [
    { type: "keyDown", value: HOME }, { type: "keyUp", value: HOME },
  ] }]);
  await session.releaseActions();
  const afterHome = await view(session);

  await session.execute(`window.__forge3dSaf04.capturedPointerId = null;
    window.__forge3dSaf04.releasedPointerId = null; window.__forge3dSaf04.lastPointerId = null;`);
  const cancelSource = { type: "pointer", id: "safari-cancel", parameters: { pointerType: "mouse" } };
  await session.performActions([{ ...cancelSource, actions: [
    { type: "pointerMove", origin: canvasOrigin, x: 0, y: 0, duration: 0 }, { type: "pointerDown", button: 0 },
  ] }]);
  await session.performActions([{ ...cancelSource, actions: [
    { type: "pointerMove", origin: "viewport", x: Math.floor(rect.x + rect.width / 2 + 12),
      y: Math.floor(rect.y + rect.height / 2 + 12), duration: 50 },
  ] }]);
  const cancelCapture = await session.execute(`
    const fixture = window.__forge3dInteractiveViewer; const state = window.__forge3dSaf04;
    return { pointerId: state.lastPointerId, capturedPointerId: state.capturedPointerId,
      trustedMovePointerId: state.lastMovePointerId,
      hasPointerCapture: fixture.canvas.hasPointerCapture(state.lastPointerId),
      activePointers: fixture.viewer.getDiagnostics().activePointers };
  `);
  const cancelImmediate = await session.execute(`
    const fixture = window.__forge3dInteractiveViewer;
    const id = window.__forge3dSaf04.lastPointerId;
    fixture.canvas.dispatchEvent(new PointerEvent("pointercancel", { pointerId: id, pointerType: "mouse", bubbles: true }));
    return { cancelledPointerId: id,
      hasPointerCapture: fixture.canvas.hasPointerCapture(id),
      activePointers: fixture.viewer.getDiagnostics().activePointers };
  `);
  await session.performActions([{ ...cancelSource, actions: [
    { type: "pointerMove", origin: "viewport", x: Math.floor(rect.x + rect.width / 2 + 24),
      y: Math.floor(rect.y + rect.height / 2 + 24), duration: 50 },
  ] }]);
  const cancelReleased = await session.execute(`
    const fixture = window.__forge3dInteractiveViewer; const state = window.__forge3dSaf04;
    return { trustedMovePointerId: state.lastMovePointerId, releasedPointerId: state.releasedPointerId,
      hasPointerCapture: fixture.canvas.hasPointerCapture(state.lastPointerId),
      activePointers: fixture.viewer.getDiagnostics().activePointers };
  `);
  await session.releaseActions();

  const layout = await runLayoutAcceptance(session);
  const zoom = await runBrowserZoomAcceptance(session);
  const lifecycleAcceptance = await runBfcacheAcceptance(session, payload.route.applicationUrl);
  const generationBefore = lifecycleAcceptance.baseline.generation;
  const liveGestureListeners = await session.execute("return window.__forge3dSaf04.gestureSnapshot();");
  const finalState = await session.execute(`
    const fixture = window.__forge3dInteractiveViewer;
    const generation = fixture.viewer.getDiagnostics().generation;
    fixture.viewer.dispose();
    const gestureListeners = window.__forge3dSaf04.gestureSnapshot();
    window.__forge3dSaf04.restoreGestureTracking();
    return { generation, gestureListeners,
      contextMenuSuppressed: window.__forge3dSaf04.contextMenuSuppressed,
      pointerReleased: window.__forge3dSaf04.pointerReleased };
  `);
  await session.refresh();
  const hardReloadPersisted = await session.execute(
    "return window.__forge3dLifecycle.pageshow.at(-1)?.persisted ?? null;",
  );

  const saf04Proof = {
    schemaVersion: 1,
    kind: "forge3d-saf04-safari-lifecycle-proof-v1",
    binding: {
      lane: payload.binding.lane,
      assetId: payload.binding.assetId,
      commit: payload.binding.commit,
      packageSha256: payload.binding.packageSha256,
    },
    controls: {
      orbit: changed(initial, afterOrbit),
      pan: changed(afterOrbit, afterPan),
      wheelZoom: changed(afterPan, afterWheel),
      keyboardReset: {
        preResetDiffersFromInitial: changed(initial, afterWheel),
        matchesInitial: !changed(initial, afterHome),
      },
      pointer: {
        ...pointerAcceptance.proof,
        cancelledPointerId: cancelImmediate.cancelledPointerId,
        cancelCapturedPointerId: cancelCapture.capturedPointerId,
        cancelEstablishMovePointerId: cancelCapture.trustedMovePointerId,
        cancelPostMovePointerId: cancelReleased.trustedMovePointerId,
        cancelCaptureEstablished: cancelCapture.hasPointerCapture === true && cancelCapture.activePointers === 1,
        cancelImmediateHasPointerCapture: cancelImmediate.hasPointerCapture,
        cancelImmediateActivePointers: cancelImmediate.activePointers,
        cancelReleasedPointerId: cancelReleased.releasedPointerId,
        cancelHasPointerCapture: cancelReleased.hasPointerCapture,
        cancelReleased: cancelReleased.activePointers === 0,
      },
      contextMenuSuppressed: finalState.contextMenuSuppressed === true,
      gestureListeners: {
        targets: ["canvas", "document", "window"],
        whileLive: liveGestureListeners.active,
        afterDispose: finalState.gestureListeners.active,
        everAdded: finalState.gestureListeners.everAdded,
      },
    },
    layout: {
      fractionalDpr: !Number.isInteger(zoom.dprAfter),
      browserZoom: zoom,
      displayNoneCycles: layout.displayNoneCycles,
      zeroParentCycles: layout.zeroParentCycles,
    },
    lifecycle: {
      baseline: lifecycleAcceptance.baseline,
      bfcacheCycles: lifecycleAcceptance.cycles,
      hardReloadPersisted,
      generationBefore,
      generationAfter: finalState.generation,
    },
  };
  validateSaf04HardwareProof(saf04Proof, saf04Proof.binding);
  return { ...result, saf04Proof };
}

async function initializeViewer(session) {
  const result = await session.executeAsync(`
    const done = arguments[arguments.length - 1];
    (async () => {
      const fixture = window.__forge3dInteractiveViewer;
      const canvas = fixture.canvas;
      const gestureTypes = new Set(["gesturestart", "gesturechange", "gestureend"]);
      const inputTypes = ["pointerdown", "pointermove", "pointerup", "pointercancel", "lostpointercapture",
        "pointerleave", "wheel", "contextmenu", "keydown"];
      const inputActive = new Map(inputTypes.map((type) => [type, new Set()]));
      const harnessListeners = new WeakSet();
      const tracked = [[canvas, "canvas"], [document, "document"], [window, "window"]].map(([target, name]) => {
        const ownAdd = Object.getOwnPropertyDescriptor(target, "addEventListener");
        const ownRemove = Object.getOwnPropertyDescriptor(target, "removeEventListener");
        const originalAdd = target.addEventListener;
        const originalRemove = target.removeEventListener;
        const active = new Set();
        let everAdded = 0;
        target.addEventListener = function(type, listener, options) {
          if (gestureTypes.has(type) && listener != null) { active.add(listener); everAdded += 1; }
          if (name === "canvas" && inputActive.has(type) && listener != null && !harnessListeners.has(listener)) inputActive.get(type).add(listener);
          return originalAdd.call(this, type, listener, options);
        };
        target.removeEventListener = function(type, listener, options) {
          if (gestureTypes.has(type) && listener != null) active.delete(listener);
          if (name === "canvas" && inputActive.has(type) && listener != null) inputActive.get(type).delete(listener);
          return originalRemove.call(this, type, listener, options);
        };
        return { name, active, get everAdded() { return everAdded; }, restore() {
          if (ownAdd) Object.defineProperty(target, "addEventListener", ownAdd); else delete target.addEventListener;
          if (ownRemove) Object.defineProperty(target, "removeEventListener", ownRemove); else delete target.removeEventListener;
        } };
      });
      window.__forge3dSaf04 = { pointerCaptured: false, pointerReleased: false,
        contextMenuSuppressed: false, lastPointerId: null, capturedPointerId: null,
        releasedPointerId: null, lastMovePointerId: null, lastMoveX: null, lastMoveY: null,
        gestureSnapshot() { return { active: tracked.reduce((sum, item) => sum + item.active.size, 0),
          everAdded: tracked.reduce((sum, item) => sum + item.everAdded, 0) }; },
        inputSnapshot() { const counts = inputTypes.map((type) => inputActive.get(type).size);
          return { sets: counts.every((count) => count === counts[0]) ? counts[0] : -1,
            signature: Object.fromEntries(inputTypes.map((type, index) => [type, counts[index]])) }; },
        restoreGestureTracking() { for (const item of tracked) item.restore(); } };
      const viewer = await fixture.create({ resize: true, controls: { keyboard: true } });
      const onPointerDown = (event) => { window.__forge3dSaf04.lastPointerId = event.pointerId; };
      const onPointerMove = (event) => { window.__forge3dSaf04.lastMovePointerId = event.pointerId;
        window.__forge3dSaf04.lastMoveX = event.clientX; window.__forge3dSaf04.lastMoveY = event.clientY; };
      const onGotPointerCapture = (event) => { window.__forge3dSaf04.pointerCaptured = true;
        window.__forge3dSaf04.capturedPointerId = event.pointerId; };
      const onLostPointerCapture = (event) => { window.__forge3dSaf04.pointerReleased = true;
        window.__forge3dSaf04.releasedPointerId = event.pointerId; };
      const onContextMenu = (event) => { window.__forge3dSaf04.contextMenuSuppressed ||= event.defaultPrevented; };
      for (const listener of [onPointerDown, onPointerMove, onGotPointerCapture, onLostPointerCapture, onContextMenu]) {
        harnessListeners.add(listener);
      }
      canvas.addEventListener("pointerdown", onPointerDown);
      canvas.addEventListener("pointermove", onPointerMove);
      canvas.addEventListener("gotpointercapture", onGotPointerCapture);
      canvas.addEventListener("lostpointercapture", onLostPointerCapture);
      canvas.addEventListener("contextmenu", onContextMenu);
      for (let attempt = 0; attempt < 120 && viewer.getDiagnostics().submittedFrames === 0; attempt += 1) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      done({ ok: true });
    })().catch((error) => done({ ok: false, error: String(error?.message ?? error) }));
  `);
  if (result?.ok !== true) {
    throw new Error("SAF-04 Safari viewer initialization failed");
  }
}

async function pointerDrag(session, origin, rect, button, targetX, targetY) {
  await session.performActions([{ type: "pointer", id: `safari-pointer-${button}`, parameters: { pointerType: "mouse" }, actions: [
    { type: "pointerMove", origin, x: 0, y: 0, duration: 0 },
    { type: "pointerDown", button },
    { type: "pointerMove", origin: "viewport", x: Math.floor(targetX), y: Math.floor(targetY), duration: 150 },
    { type: "pointerUp", button },
  ] }]);
  await session.releaseActions();
}

async function runPointerCaptureAcceptance(session, origin, rect, initialView) {
  const firstOutside = { x: Math.floor(rect.x + rect.width + 32), y: Math.max(0, Math.floor(rect.y + rect.height / 2)) };
  const secondOutside = { x: firstOutside.x + 48, y: firstOutside.y + 24 };
  const source = { type: "pointer", id: "safari-pointer-capture", parameters: { pointerType: "mouse" } };
  await session.performActions([{ ...source, actions: [
    { type: "pointerMove", origin, x: 0, y: 0, duration: 0 },
    { type: "pointerDown", button: 0 },
    { type: "pointerMove", origin: "viewport", ...firstOutside, duration: 150 },
  ] }]);
  const first = await session.execute(`
    const fixture = window.__forge3dInteractiveViewer; const state = window.__forge3dSaf04;
    const id = state.lastPointerId;
    return { pointerId: id, capturedPointerId: state.capturedPointerId,
      outsidePointerId: state.lastMovePointerId, captured: fixture.canvas.hasPointerCapture(id),
      outside: state.lastMoveX > fixture.canvas.getBoundingClientRect().right ||
        state.lastMoveX < fixture.canvas.getBoundingClientRect().left ||
        state.lastMoveY > fixture.canvas.getBoundingClientRect().bottom ||
        state.lastMoveY < fixture.canvas.getBoundingClientRect().top,
      activePointers: fixture.viewer.getDiagnostics().activePointers, view: fixture.viewer.getView() };
  `);
  await session.performActions([{ ...source, actions: [
    { type: "pointerMove", origin: "viewport", ...secondOutside, duration: 150 },
  ] }]);
  const second = await session.execute(`
    const fixture = window.__forge3dInteractiveViewer; const state = window.__forge3dSaf04;
    const id = state.lastPointerId;
    return { continuedPointerId: state.lastMovePointerId, captured: fixture.canvas.hasPointerCapture(id),
      activePointers: fixture.viewer.getDiagnostics().activePointers, view: fixture.viewer.getView() };
  `);
  await session.performActions([{ ...source, actions: [{ type: "pointerUp", button: 0 }] }]);
  const released = await session.execute(`
    const fixture = window.__forge3dInteractiveViewer; const state = window.__forge3dSaf04;
    return { releasedPointerId: state.releasedPointerId, captured: fixture.canvas.hasPointerCapture(state.lastPointerId),
      activePointers: fixture.viewer.getDiagnostics().activePointers };
  `);
  await session.releaseActions();
  return {
    afterView: second.view,
    proof: {
      pointerId: first.pointerId,
      capturedPointerId: first.capturedPointerId,
      outsidePointerId: first.outsidePointerId,
      continuedPointerId: second.continuedPointerId,
      releasedPointerId: released.releasedPointerId,
      capturedOutside: first.captured === true && first.outside === true,
      activeOutside: first.activePointers,
      cameraChangedOutside: changed(initialView, first.view),
      captureRetainedForFurtherMovement: second.captured === true && second.activePointers === 1,
      cameraChangedAfterFurtherMovement: changed(first.view, second.view),
      releasedSamePointer: released.captured === false,
      activePointersAfterRelease: released.activePointers,
    },
  };
}

async function view(session) {
  return session.execute("return window.__forge3dInteractiveViewer.viewer.getView();");
}

function changed(left, right) {
  return JSON.stringify(left) !== JSON.stringify(right);
}

async function runLayoutAcceptance(session) {
  const result = await session.executeAsync(`
    const done = arguments[arguments.length - 1];
    (async () => {
      const fixture = window.__forge3dInteractiveViewer;
      const viewer = fixture.viewer;
      const canvas = fixture.canvas;
      const parent = canvas.parentElement;
      const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
      async function cycles(kind) {
        const results = [];
        for (let index = 0; index < 30; index += 1) {
          const canvasStyle = canvas.getAttribute("style");
          const parentStyle = parent.getAttribute("style");
          if (kind === "display-none") canvas.style.display = "none";
          else { parent.style.width = "0px"; parent.style.height = "0px"; parent.style.minWidth = "0px";
            parent.style.padding = "0"; parent.style.gap = "0"; parent.style.gridTemplateColumns = "0px";
            parent.style.boxSizing = "border-box"; parent.style.overflow = "hidden";
            canvas.style.width = "0px"; canvas.style.height = "0px"; canvas.style.border = "0"; }
          let reachedZeroRect = false;
          for (let attempt = 0; attempt < 120; attempt += 1) {
            await nextFrame();
            const rect = canvas.getBoundingClientRect();
            const parentRect = parent.getBoundingClientRect();
            const parentIsZero = kind === "display-none" || (parentRect.width === 0 && parentRect.height === 0);
            if (rect.width === 0 && rect.height === 0 && parentIsZero &&
                viewer.getDiagnostics().pendingAnimationFrame === false) {
              reachedZeroRect = true;
              break;
            }
          }
          if (!reachedZeroRect) throw new Error(kind + " did not reach a suspended zero-area layout");
          await nextFrame();
          const hiddenBefore = viewer.getDiagnostics();
          const view = viewer.getView(); viewer.setView({ ...view, yawDegrees: view.yawDegrees + 0.01 });
          await nextFrame(); await nextFrame(); await nextFrame();
          const hiddenAfter = viewer.getDiagnostics();
          if (canvasStyle === null) canvas.removeAttribute("style"); else canvas.setAttribute("style", canvasStyle);
          if (parentStyle === null) parent.removeAttribute("style"); else parent.setAttribute("style", parentStyle);
          let recovered;
          for (let attempt = 0; attempt < 120; attempt += 1) {
            await nextFrame(); recovered = viewer.getDiagnostics();
            if (recovered.submittedFrames > hiddenAfter.submittedFrames) break;
          }
          results.push({ cycle: index + 1,
            hiddenSubmittedDelta: hiddenAfter.submittedFrames - hiddenBefore.submittedFrames,
            recovered: recovered.submittedFrames > hiddenAfter.submittedFrames,
            activeObservers: recovered.activeObservers, activeRuntimes: recovered.activeRuntimes,
            pendingAnimationFrame: recovered.pendingAnimationFrame,
            ownedAnimationFrameCount: recovered.ownedAnimationFrameCount });
        }
        return results;
      }
      done({ ok: true, value: { displayNoneCycles: await cycles("display-none"), zeroParentCycles: await cycles("zero-parent") } });
    })().catch((error) => done({ ok: false, error: String(error?.message ?? error) }));
  `);
  if (result?.ok !== true) throw new Error("SAF-04 real DOM layout acceptance failed");
  return result.value;
}

async function runBrowserZoomAcceptance(session) {
  const before = await session.execute(`
    document.activeElement?.blur();
    const fixture = window.__forge3dInteractiveViewer; const style = getComputedStyle(fixture.canvas);
    const cssWidth = Number.parseFloat(style.width); const cssHeight = Number.parseFloat(style.height);
    const diagnostics = fixture.viewer.getDiagnostics();
    return { dpr: devicePixelRatio, cssWidth, cssHeight,
      backingWidth: fixture.canvas.width, backingHeight: fixture.canvas.height,
      effectiveDpr: diagnostics.effectiveMaxDevicePixelRatio === 0 ? 0 :
        Math.min(fixture.canvas.width / cssWidth, fixture.canvas.height / cssHeight),
      maxEffectiveDpr: diagnostics.effectiveMaxDevicePixelRatio,
      maxCanvasPixels: diagnostics.effectiveResourceBudget.maxCanvasPixels,
      maxTextureDimension2D: fixture.viewer.getCapabilities().maxTextureDimension2D,
      submittedFrames: diagnostics.submittedFrames };
  `);
  await session.performActions([{ type: "key", id: "safari-browser-zoom", actions: [
    { type: "keyDown", value: META }, { type: "keyDown", value: "-" },
    { type: "keyUp", value: "-" }, { type: "keyUp", value: META },
  ] }]);
  await session.releaseActions();
  const after = await session.executeAsync(`
    const before = arguments[0]; const done = arguments[arguments.length - 1];
    let remaining = 60;
    const observe = () => {
      const fixture = window.__forge3dInteractiveViewer; const style = getComputedStyle(fixture.canvas);
      const cssWidth = Number.parseFloat(style.width); const cssHeight = Number.parseFloat(style.height);
      const diagnostics = fixture.viewer.getDiagnostics();
      const value = { dpr: devicePixelRatio, cssWidth, cssHeight,
        backingWidth: fixture.canvas.width, backingHeight: fixture.canvas.height,
        effectiveDpr: Math.min(fixture.canvas.width / cssWidth, fixture.canvas.height / cssHeight),
        submittedFrames: diagnostics.submittedFrames };
      if ((value.dpr !== before.dpr &&
          (value.backingWidth !== before.backingWidth || value.backingHeight !== before.backingHeight) &&
          value.submittedFrames > before.submittedFrames) || remaining-- === 0) done(value);
      else requestAnimationFrame(observe);
    };
    observe();
  `, [before]);
  await session.performActions([{ type: "key", id: "safari-browser-zoom-reset", actions: [
    { type: "keyDown", value: META }, { type: "keyDown", value: "0" },
    { type: "keyUp", value: "0" }, { type: "keyUp", value: META },
  ] }]);
  await session.releaseActions();
  const reset = await session.executeAsync(`
    const expected = arguments[0]; const done = arguments[arguments.length - 1];
    let remaining = 60;
    const observe = () => {
      const fixture = window.__forge3dInteractiveViewer; const style = getComputedStyle(fixture.canvas);
      const cssWidth = Number.parseFloat(style.width); const cssHeight = Number.parseFloat(style.height);
      const diagnostics = fixture.viewer.getDiagnostics();
      const value = { dpr: devicePixelRatio, backingWidth: fixture.canvas.width,
        backingHeight: fixture.canvas.height,
        effectiveDpr: Math.min(fixture.canvas.width / cssWidth, fixture.canvas.height / cssHeight),
        submittedFrames: diagnostics.submittedFrames };
      if ((value.dpr === expected.dpr && value.backingWidth === expected.backingWidth &&
          value.backingHeight === expected.backingHeight && value.submittedFrames > arguments[1]) || remaining-- === 0) done(value);
      else requestAnimationFrame(observe);
    };
    observe();
  `, [before, after.submittedFrames]);
  return {
    dprBefore: before.dpr, dprAfter: after.dpr,
    cssWidthBefore: before.cssWidth, cssHeightBefore: before.cssHeight,
    cssWidthAfter: after.cssWidth, cssHeightAfter: after.cssHeight,
    backingWidthBefore: before.backingWidth, backingHeightBefore: before.backingHeight,
    backingWidthAfter: after.backingWidth, backingHeightAfter: after.backingHeight,
    effectiveDprBefore: before.effectiveDpr, effectiveDprAfter: after.effectiveDpr,
    maxEffectiveDpr: before.maxEffectiveDpr, maxCanvasPixels: before.maxCanvasPixels,
    maxTextureDimension2D: before.maxTextureDimension2D,
    submittedDelta: after.submittedFrames - before.submittedFrames,
    resetDpr: reset.dpr, resetBackingWidth: reset.backingWidth, resetBackingHeight: reset.backingHeight,
    resetEffectiveDpr: reset.effectiveDpr, resetSubmittedDelta: reset.submittedFrames - after.submittedFrames,
  };
}

async function runBfcacheAcceptance(session, applicationUrl) {
  const awayUrl = new URL("lifecycle-away.html", applicationUrl).href;
  const baseline = await session.execute(`
    const fixture = window.__forge3dInteractiveViewer; const diagnostics = fixture.viewer.getDiagnostics();
    const token = () => String(Date.now()) + "-" + String(Math.random());
    window.__forge3dSaf04.lifecycleIdentity = { document, viewer: fixture.viewer, canvas: fixture.canvas,
      generation: diagnostics.generation, documentToken: token(), viewerToken: token(), canvasToken: token() };
    return { documentToken: window.__forge3dSaf04.lifecycleIdentity.documentToken,
      viewerToken: window.__forge3dSaf04.lifecycleIdentity.viewerToken,
      canvasToken: window.__forge3dSaf04.lifecycleIdentity.canvasToken,
      generation: diagnostics.generation, ownedListeners: diagnostics.ownedListeners,
      inputControllerSets: window.__forge3dSaf04.inputSnapshot().sets,
      activeObservers: diagnostics.activeObservers, activeRuntimes: diagnostics.activeRuntimes,
      activePointers: diagnostics.activePointers, pagehideCount: window.__forge3dLifecycle.pagehide.length,
      pageshowCount: window.__forge3dLifecycle.pageshow.length };
  `);
  const cycles = [];
  for (let index = 0; index < 30; index += 1) {
    const preNavigationIdentityStable = await session.execute(`
      const fixture = window.__forge3dInteractiveViewer; const identity = window.__forge3dSaf04.lifecycleIdentity;
      const diagnostics = fixture.viewer.getDiagnostics();
      return identity.document === document && identity.viewer === fixture.viewer && identity.canvas === fixture.canvas &&
        identity.generation === diagnostics.generation;
    `);
    await session.navigate(awayUrl);
    await session.back();
    const state = await session.execute(`
      const fixture = window.__forge3dInteractiveViewer; const identity = window.__forge3dSaf04.lifecycleIdentity;
      const diagnostics = fixture.viewer.getDiagnostics();
      const pagehide = window.__forge3dLifecycle.pagehide.at(-1);
      const pageshow = window.__forge3dLifecycle.pageshow.at(-1);
      fixture.canvas.focus();
      return { viewBefore: fixture.viewer.getView(), submittedBefore: diagnostics.submittedFrames,
        pagehideEventId: pagehide?.id ?? null, pageshowEventId: pageshow?.id ?? null,
        pagehideCount: window.__forge3dLifecycle.pagehide.length, pageshowCount: window.__forge3dLifecycle.pageshow.length,
        pagehidePersisted: pagehide?.persisted ?? null, pageshowPersisted: pageshow?.persisted ?? null,
        pagehideTrusted: pagehide?.trusted ?? null, pageshowTrusted: pageshow?.trusted ?? null,
        postNavigationIdentityStable: identity.document === document && identity.viewer === fixture.viewer &&
          identity.canvas === fixture.canvas && identity.generation === diagnostics.generation,
        activeObservers: diagnostics.activeObservers, activePointers: diagnostics.activePointers,
        activeRuntimes: diagnostics.activeRuntimes };
    `);
    await session.performActions([{ type: "key", id: `safari-bfcache-key-${index + 1}`, actions: [
      { type: "keyDown", value: ARROW_RIGHT }, { type: "keyUp", value: ARROW_RIGHT },
    ] }]);
    await session.releaseActions();
    const postInput = await session.executeAsync(`
      const done = arguments[arguments.length - 1];
      (async () => {
      const before = arguments[0]; const fixture = window.__forge3dInteractiveViewer;
      let after = fixture.viewer.getDiagnostics();
      for (let attempt = 0; attempt < 120 && after.submittedFrames <= before.submittedBefore; attempt += 1) {
        await new Promise((resolve) => requestAnimationFrame(resolve)); after = fixture.viewer.getDiagnostics();
      }
      const viewAfter = fixture.viewer.getView();
      done({ runtimeGeneration: after.generation, ownedListeners: after.ownedListeners,
        inputControllerSets: window.__forge3dSaf04.inputSnapshot().sets,
        recoveryAttempts: after.recoveryAttempts,
        pendingAnimationFrame: after.pendingAnimationFrame, ownedAnimationFrameCount: after.ownedAnimationFrameCount,
        postReturnInputChanged: JSON.stringify(before.viewBefore) !== JSON.stringify(viewAfter),
        postReturnSubmittedDelta: after.submittedFrames - before.submittedBefore });
      })().catch((error) => done({ error: String(error?.message ?? error) }));
    `, [state]);
    if (postInput?.error) throw new Error(`SAF-04 BFCache post-return check failed: ${postInput.error}`);
    delete state.viewBefore; delete state.submittedBefore;
    cycles.push({ cycle: index + 1, preNavigationIdentityStable, ...state, ...postInput });
  }
  return { baseline, cycles };
}
