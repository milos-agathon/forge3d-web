const STATE_KEY = "__forge3dBfcacheLifecycle";
const READY_KEY = "__forge3dBfcacheLifecycleReady";

export function installViewerBfcacheLifecycle(fixture) {
  if (!fixture?.canvas || typeof fixture.create !== "function") {
    throw new Error("FFX04_FIXTURE_UNAVAILABLE");
  }
  if (window[STATE_KEY]) return window[STATE_KEY];
  const state = {
    schemaVersion: 1,
    documentToken: crypto.randomUUID(),
    viewer: null,
    canvas: fixture.canvas,
    pagehide: [],
    pageshow: [],
    errors: [],
  };
  window[STATE_KEY] = state;
  window[READY_KEY] = (async () => {
    state.viewer = await fixture.create({
      onError: (error) => state.errors.push(String(error?.code ?? error?.message ?? error)),
    });
    window.addEventListener("pagehide", (event) => {
      state.pagehide.push(transition(event, state));
    });
    window.addEventListener("pageshow", (event) => {
      if (event.persisted) state.pageshow.push(transition(event, state));
    });
    await animationFrames(2);
    return snapshot(state);
  })();
  return state;
}

export async function prepareViewerBfcacheCycle(cycle) {
  const state = requiredState();
  await window[READY_KEY];
  assertPositiveCycle(cycle);
  await animationFrames(2);
  const current = snapshot(state);
  assertReady(current, `cycle ${cycle} prepare`);
  return { cycle, ...current };
}

export async function observeViewerBfcacheRestore(cycle) {
  const state = requiredState();
  assertPositiveCycle(cycle);
  const deadline = performance.now() + 5_000;
  while (state.pageshow.length < cycle && performance.now() < deadline) {
    await animationFrames(1);
  }
  if (state.pagehide.length !== cycle || state.pageshow.length !== cycle) {
    throw new Error(`FFX04_TRANSITION_COUNT cycle=${cycle}`);
  }
  await animationFrames(2);
  const restored = snapshot(state);
  const hidden = state.pagehide[cycle - 1];
  const shown = state.pageshow[cycle - 1];
  assertReady(restored, `cycle ${cycle} restore`);
  if (!hidden.trusted || !hidden.persisted || !shown.trusted || !shown.persisted) {
    throw new Error(`FFX04_UNTRUSTED_OR_NONPERSISTED cycle=${cycle}`);
  }
  if (hidden.diagnostics.pendingAnimationFrame || hidden.diagnostics.ownedAnimationFrameCount !== 0) {
    throw new Error(`FFX04_HIDDEN_RAF_OWNED cycle=${cycle}`);
  }
  if (
    restored.diagnostics.submittedFrames !== hidden.diagnostics.submittedFrames + 1 ||
    restored.diagnostics.skippedFrames !== hidden.diagnostics.skippedFrames
  ) {
    throw new Error(`FFX04_RESUME_FRAME_COUNT cycle=${cycle}`);
  }
  return { cycle, hidden, shown, restored };
}

export async function exerciseViewerAfterBfcache() {
  const state = requiredState();
  const before = state.viewer.getView();
  const beforeDiagnostics = state.viewer.getDiagnostics();
  state.canvas.focus();
  state.canvas.dispatchEvent(new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: "ArrowRight",
  }));
  await animationFrames(2);
  const after = state.viewer.getView();
  if (JSON.stringify(before) === JSON.stringify(after)) {
    throw new Error("FFX04_POST_RESTORE_INPUT_FAILED");
  }
  const current = snapshot(state);
  if (
    current.diagnostics.submittedFrames !== beforeDiagnostics.submittedFrames + 1 ||
    current.diagnostics.skippedFrames !== beforeDiagnostics.skippedFrames
  ) {
    throw new Error("FFX04_POST_RESTORE_INPUT_FRAME_COUNT");
  }
  return { before, after, snapshot: current, inputBoundary: "dom-dispatch" };
}

export function disposeViewerBfcacheLifecycle() {
  const state = requiredState();
  state.viewer.dispose();
  const disposed = snapshot(state);
  const diagnostics = disposed.diagnostics;
  if (
    disposed.status !== "disposed" ||
    disposed.sameViewer !== true ||
    disposed.sameCanvas !== true ||
    diagnostics.ownedListeners !== 0 ||
    diagnostics.activeObservers !== 0 ||
    diagnostics.activePointers !== 0 ||
    diagnostics.activeRuntimes !== 0 ||
    diagnostics.pendingAnimationFrame ||
    diagnostics.ownedAnimationFrameCount !== 0 ||
    diagnostics.recoveryAttempts !== 0 ||
    diagnostics.screenshotInFlight !== false
  ) {
    throw new Error("FFX04_FINAL_CLEANUP_FAILED");
  }
  return disposed;
}

function transition(event, state) {
  const current = snapshot(state);
  return {
    trusted: event.isTrusted,
    persisted: event.persisted === true,
    ...current,
  };
}

function snapshot(state) {
  const viewer = state.viewer;
  if (!viewer) throw new Error("FFX04_VIEWER_NOT_READY");
  return {
    documentToken: state.documentToken,
    sameViewer: viewer === window.__forge3dInteractiveViewer.viewer,
    sameCanvas: state.canvas === window.__forge3dInteractiveViewer.canvas,
    status: viewer.status,
    disposed: viewer.disposed,
    view: viewer.getView(),
    diagnostics: viewer.getDiagnostics(),
    errors: [...state.errors],
  };
}

function assertReady(value, label) {
  const diagnostics = value.diagnostics;
  if (
    value.status !== "ready" || value.disposed || value.sameViewer !== true || value.sameCanvas !== true ||
    diagnostics.activeRuntimes !== 1 || diagnostics.recoveryAttempts !== 0 ||
    diagnostics.activeObservers !== 1 || diagnostics.activePointers !== 0 ||
    !Number.isInteger(diagnostics.ownedListeners) || diagnostics.ownedListeners < 1 ||
    diagnostics.pendingAnimationFrame || diagnostics.ownedAnimationFrameCount !== 0 ||
    diagnostics.screenshotInFlight !== false ||
    value.errors.length !== 0
  ) {
    throw new Error(`FFX04_VIEWER_UNHEALTHY ${label}`);
  }
}

function requiredState() {
  const state = window[STATE_KEY];
  if (!state) throw new Error("FFX04_STATE_UNAVAILABLE");
  return state;
}

function assertPositiveCycle(cycle) {
  if (!Number.isInteger(cycle) || cycle < 1 || cycle > 3) {
    throw new Error("FFX04_CYCLE_INVALID");
  }
}

function animationFrames(count) {
  return new Promise((resolve) => {
    const next = () => count-- <= 0 ? resolve() : requestAnimationFrame(next);
    next();
  });
}
