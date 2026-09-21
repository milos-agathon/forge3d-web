import assert from "node:assert/strict";
import test from "node:test";

import {
  installViewerBfcacheLifecycle,
  observeViewerBfcacheRestore,
  prepareViewerBfcacheCycle,
} from "../browser/viewer-bfcache-lifecycle.js";

test("browser BFCache helper accepts one controlled persisted restore and rejects unsafe transitions", async () => {
  await runScenario({});
  for (const [options, message] of [
    [{ hiddenOwnedRaf: true }, /FFX04_HIDDEN_RAF_OWNED/u],
    [{ trusted: false }, /FFX04_UNTRUSTED_OR_NONPERSISTED/u],
    [{ persisted: false }, /FFX04_UNTRUSTED_OR_NONPERSISTED/u],
    [{ submittedIncrement: 2 }, /FFX04_RESUME_FRAME_COUNT/u],
    [{ screenshotInFlight: true }, /FFX04_VIEWER_UNHEALTHY/u],
  ]) {
    await assert.rejects(() => runScenario(options), message);
  }
});

async function runScenario({
  hiddenOwnedRaf = false,
  trusted = true,
  persisted = true,
  submittedIncrement = 1,
  screenshotInFlight = false,
}) {
  const previousWindow = globalThis.window;
  const previousRaf = globalThis.requestAnimationFrame;
  const listeners = new Map();
  const canvas = new EventTarget();
  canvas.focus = () => {};
  const diagnostics = {
    generation: 1,
    submittedFrames: 0,
    skippedFrames: 0,
    activeRuntimes: 1,
    activeObservers: 1,
    activePointers: 0,
    recoveryAttempts: 0,
    pendingAnimationFrame: false,
    ownedAnimationFrameCount: 0,
    ownedListeners: 16,
    screenshotInFlight: false,
  };
  const viewer = {
    status: "ready",
    disposed: false,
    getView: () => ({ yawDegrees: 0 }),
    getDiagnostics: () => ({ ...diagnostics }),
  };
  let resumePending = false;
  const fakeWindow = {
    __forge3dInteractiveViewer: { viewer, canvas },
    addEventListener(type, listener) {
      const entries = listeners.get(type) ?? [];
      entries.push(listener);
      listeners.set(type, entries);
    },
  };
  globalThis.window = fakeWindow;
  globalThis.requestAnimationFrame = (callback) => {
    queueMicrotask(() => {
      if (resumePending) {
        resumePending = false;
        diagnostics.pendingAnimationFrame = false;
        diagnostics.ownedAnimationFrameCount = 0;
        diagnostics.submittedFrames += submittedIncrement;
        diagnostics.screenshotInFlight = screenshotInFlight;
      }
      callback(performance.now());
    });
    return 1;
  };
  try {
    installViewerBfcacheLifecycle({
      canvas,
      create: async () => {
        await Promise.resolve();
        fakeWindow.addEventListener("pagehide", () => {
          if (!hiddenOwnedRaf) {
            diagnostics.pendingAnimationFrame = false;
            diagnostics.ownedAnimationFrameCount = 0;
          }
        });
        fakeWindow.addEventListener("pageshow", (event) => {
          if (!event.persisted) return;
          diagnostics.pendingAnimationFrame = true;
          diagnostics.ownedAnimationFrameCount = 1;
          resumePending = true;
        });
        return viewer;
      },
    });
    await fakeWindow.__forge3dBfcacheLifecycleReady;
    const prepared = await prepareViewerBfcacheCycle(1);
    assert.equal(prepared.sameViewer, true);
    assert.equal(prepared.sameCanvas, true);

    diagnostics.pendingAnimationFrame = true;
    diagnostics.ownedAnimationFrameCount = 1;
    for (const listener of listeners.get("pagehide") ?? []) {
      listener({ isTrusted: trusted, persisted });
    }
    for (const listener of listeners.get("pageshow") ?? []) {
      listener({ isTrusted: true, persisted: true });
    }
    const result = await observeViewerBfcacheRestore(1);
    assert.equal(result.hidden.diagnostics.pendingAnimationFrame, false);
    assert.equal(result.hidden.diagnostics.ownedAnimationFrameCount, 0);
    assert.equal(result.shown.diagnostics.pendingAnimationFrame, true);
    assert.equal(result.shown.diagnostics.ownedAnimationFrameCount, 1);
    assert.equal(result.restored.diagnostics.submittedFrames, 1);
    assert.equal(result.restored.diagnostics.screenshotInFlight, false);
    return result;
  } finally {
    globalThis.window = previousWindow;
    globalThis.requestAnimationFrame = previousRaf;
  }
}
