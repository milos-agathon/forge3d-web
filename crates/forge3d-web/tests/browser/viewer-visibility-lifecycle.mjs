export const VIEWER_VISIBILITY_LIFECYCLE_CYCLES = 30;

const SYNTHETIC_VISIBILITY_KEY = "__forge3dSyntheticVisibilityLifecycle";
const CANVAS_IDENTITY_KEY = "__forge3dVisibilityLifecycleCanvas";
const PENDING_PROBE_KEY = "__forge3dVisibilityLifecyclePendingProbe";

export function resolveViewerVisibilityLifecycleMode({
  headed,
  browserEngine,
}) {
  invariant(
    typeof headed === "boolean",
    "visibility lifecycle headed mode must be a boolean",
  );
  switch (browserEngine) {
    case "chromium":
      return createViewerVisibilityLifecycleClassification(headed);
    case "firefox":
    case "webkit":
      return createViewerVisibilityLifecycleClassification(false);
    default:
      throw new Error(
        `visibility lifecycle browser engine must be chromium, firefox, or webkit; got ${String(browserEngine)}`,
      );
  }
}

/**
 * Exercise the shared viewer through repeated document visibility transitions.
 *
 * Callers explicitly select whether this exercise must observe actual document
 * visibility transitions. Hermetic or engine-limited preflights use an
 * explicitly labelled synthetic visibilityState override so they do not depend
 * on a window manager or fabricate real-tab evidence.
 */
export async function exerciseViewerVisibilityLifecycle({
  page,
  context = page.context(),
  requireActualDocumentVisibilityTransitions,
  cycleCount = VIEWER_VISIBILITY_LIFECYCLE_CYCLES,
}) {
  invariant(
    typeof requireActualDocumentVisibilityTransitions === "boolean",
    "visibility lifecycle transition mode must be a boolean",
  );
  invariant(
    Number.isInteger(cycleCount) && cycleCount > 0,
    "visibility lifecycle cycleCount must be a positive integer",
  );

  const classification = createViewerVisibilityLifecycleClassification(
    requireActualDocumentVisibilityTransitions,
  );
  let coverPage;
  let syntheticInstalled = false;

  try {
    if (requireActualDocumentVisibilityTransitions) {
      coverPage = await context.newPage();
      await coverPage.goto("about:blank");
      await page.bringToFront();
      await waitForVisibility(page, "visible", "initial headed target tab");
    } else {
      await installSyntheticVisibility(page);
      syntheticInstalled = true;
    }

    await settleViewer(page, "initial lifecycle baseline");
    const baseline = await readViewerSnapshot(page, true);
    assertHealthyAndStable(baseline, baseline, "baseline");
    invariant(
      baseline.visibilityState === "visible",
      "baseline document visibility state must be visible",
    );
    invariant(
      baseline.diagnostics.activeRuntimes === 1,
      "baseline must own exactly one active runtime",
    );

    const cycles = [];
    for (let index = 0; index < cycleCount; index += 1) {
      const before = await readViewerSnapshot(page);
      assertHealthyAndStable(before, baseline, `cycle ${index + 1} before hide`);
      await armPendingFrameProbe(page);

      if (requireActualDocumentVisibilityTransitions) {
        await coverPage.bringToFront();
        await waitForVisibility(
          page,
          "hidden",
          `cycle ${index + 1} headed target tab`,
        );
      } else {
        await setSyntheticVisibility(page, "hidden");
      }

      const hidden = await readViewerSnapshot(page);
      const pendingProbe = await page.evaluate(
        (key) => window[key],
        PENDING_PROBE_KEY,
      );
      assertHealthyAndStable(hidden, baseline, `cycle ${index + 1} hidden`);
      invariant(
        hidden.visibilityState === "hidden",
        `cycle ${index + 1} document visibility state is not hidden`,
      );
      invariant(
        pendingProbe?.visibilityState === "hidden",
        `cycle ${index + 1} did not observe the hidden transition`,
      );
      invariant(
        pendingProbe.pendingAfterRequest === true,
        `cycle ${index + 1} did not create a pending animation frame before cancellation`,
      );
      invariant(
        hidden.diagnostics.pendingAnimationFrame === false,
        `cycle ${index + 1} hidden transition did not cancel the pending animation frame`,
      );
      invariant(
        hidden.diagnostics.renderRequests ===
          before.diagnostics.renderRequests + 1,
        `cycle ${index + 1} hidden probe did not issue exactly one render request`,
      );
      invariant(
        frameTotal(hidden.diagnostics) === frameTotal(before.diagnostics),
        `cycle ${index + 1} submitted or skipped a frame while hidden`,
      );

      if (requireActualDocumentVisibilityTransitions) {
        await page.bringToFront();
        await waitForVisibility(
          page,
          "visible",
          `cycle ${index + 1} headed target tab`,
        );
      } else {
        await setSyntheticVisibility(page, "visible");
      }

      const visible = await waitForExactlyOneFrame(
        page,
        frameTotal(hidden.diagnostics),
        index + 1,
      );
      await waitForTwoAnimationFrames(page);
      const stableVisible = await readViewerSnapshot(page);
      assertHealthyAndStable(
        stableVisible,
        baseline,
        `cycle ${index + 1} visible`,
      );
      invariant(
        stableVisible.visibilityState === "visible",
        `cycle ${index + 1} document visibility state is not visible`,
      );
      invariant(
        frameTotal(stableVisible.diagnostics) ===
          frameTotal(hidden.diagnostics) + 1,
        `cycle ${index + 1} did not remain at exactly one resumed frame`,
      );

      const submittedDelta =
        visible.diagnostics.submittedFrames -
        hidden.diagnostics.submittedFrames;
      const skippedDelta =
        visible.diagnostics.skippedFrames -
        hidden.diagnostics.skippedFrames;
      invariant(
        submittedDelta + skippedDelta === 1,
        `cycle ${index + 1} must complete exactly one submitted-or-skipped frame`,
      );
      cycles.push({
        cycle: index + 1,
        hiddenPendingFrameCancelled: true,
        visibleFrame: submittedDelta === 1 ? "submitted" : "skipped",
        renderRequests: stableVisible.diagnostics.renderRequests,
        submittedFrames: stableVisible.diagnostics.submittedFrames,
        skippedFrames: stableVisible.diagnostics.skippedFrames,
      });
    }

    const orbit = await page.evaluate(() => {
      const fixture = window.__forge3dInteractiveViewer;
      const before = fixture.viewer.getView();
      fixture.canvas.focus();
      fixture.canvas.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "ArrowRight",
        }),
      );
      return {
        before,
        after: fixture.viewer.getView(),
      };
    });
    invariant(
      JSON.stringify(orbit.before) !== JSON.stringify(orbit.after),
      "orbit control did not change the viewer view after visibility cycling",
    );
    await settleViewer(page, "post-cycle orbit render");
    const final = await readViewerSnapshot(page);
    assertHealthyAndStable(final, baseline, "final");

    return {
      ...classification,
      cycleCount,
      baseline,
      final,
      sameCanvas: final.sameCanvas,
      orbitChangedView: true,
      cycles,
    };
  } finally {
    if (requireActualDocumentVisibilityTransitions) {
      if (coverPage !== undefined) {
        await coverPage.close();
      }
      if (!page.isClosed()) {
        await page.bringToFront();
      }
    } else if (syntheticInstalled && !page.isClosed()) {
      await restoreSyntheticVisibility(page);
    }
    if (!page.isClosed()) {
      await page.evaluate((key) => {
        delete window[key];
      }, CANVAS_IDENTITY_KEY);
    }
  }
}

function createViewerVisibilityLifecycleClassification(
  actualDocumentVisibilityTransitions,
) {
  return {
    mode: actualDocumentVisibilityTransitions
      ? "headed-real-tab"
      : "deterministic-synthetic-document-visibility",
    visibilityStateSource: actualDocumentVisibilityTransitions
      ? "actual-document"
      : "deterministic-synthetic-document-override",
    actualDocumentVisibilityTransitions,
    physicalSupportEvidence: false,
    supportPromotionEligible: false,
  };
}

async function readViewerSnapshot(page, initializeCanvasIdentity = false) {
  return page.evaluate(
    ({ canvasKey, initialize }) => {
      const fixture = window.__forge3dInteractiveViewer;
      if (!fixture?.viewer || !fixture.canvas) {
        throw new Error("interactive viewer fixture is not initialized");
      }
      if (initialize) {
        window[canvasKey] = fixture.canvas;
      }
      return {
        status: fixture.viewer.status,
        visibilityState: document.visibilityState,
        sameCanvas: window[canvasKey] === fixture.canvas,
        diagnostics: fixture.viewer.getDiagnostics(),
      };
    },
    { canvasKey: CANVAS_IDENTITY_KEY, initialize: initializeCanvasIdentity },
  );
}

async function armPendingFrameProbe(page) {
  await page.evaluate((probeKey) => {
    window[probeKey] = null;
    document.addEventListener(
      "visibilitychange",
      () => {
        if (document.visibilityState !== "hidden") {
          return;
        }
        const viewer = window.__forge3dInteractiveViewer.viewer;
        const before = viewer.getDiagnostics();
        viewer.render();
        const after = viewer.getDiagnostics();
        window[probeKey] = {
          visibilityState: document.visibilityState,
          renderRequestsBefore: before.renderRequests,
          renderRequestsAfter: after.renderRequests,
          pendingAfterRequest: after.pendingAnimationFrame,
        };
      },
      { capture: true, once: true },
    );
  }, PENDING_PROBE_KEY);
}

async function installSyntheticVisibility(page) {
  await page.evaluate((key) => {
    if (window[key] !== undefined) {
      throw new Error("synthetic visibility override is already installed");
    }
    const ownDescriptor = Object.getOwnPropertyDescriptor(
      document,
      "visibilityState",
    );
    if (ownDescriptor !== undefined && ownDescriptor.configurable !== true) {
      throw new Error("document.visibilityState cannot be overridden");
    }
    window[key] = {
      ownDescriptor,
      state: "visible",
    };
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      enumerable: ownDescriptor?.enumerable ?? true,
      get() {
        return window[key].state;
      },
    });
  }, SYNTHETIC_VISIBILITY_KEY);
}

async function setSyntheticVisibility(page, state) {
  await page.evaluate(
    ({ key, nextState }) => {
      const control = window[key];
      if (control === undefined) {
        throw new Error("synthetic visibility override is not installed");
      }
      control.state = nextState;
      document.dispatchEvent(new Event("visibilitychange"));
    },
    { key: SYNTHETIC_VISIBILITY_KEY, nextState: state },
  );
}

async function restoreSyntheticVisibility(page) {
  await page.evaluate((key) => {
    const control = window[key];
    if (control === undefined) {
      return;
    }
    if (control.state !== "visible") {
      control.state = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
    }
    if (control.ownDescriptor === undefined) {
      delete document.visibilityState;
    } else {
      Object.defineProperty(
        document,
        "visibilityState",
        control.ownDescriptor,
      );
    }
    delete window[key];
  }, SYNTHETIC_VISIBILITY_KEY);
}

async function settleViewer(page, label) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const snapshot = await readViewerSnapshot(page);
    if (!snapshot.diagnostics.pendingAnimationFrame) {
      return snapshot;
    }
    await delay(20);
  }
  throw new Error(`${label} did not settle its animation frame`);
}

async function waitForVisibility(page, expected, label) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const actual = await page.evaluate(() => document.visibilityState);
    if (actual === expected) {
      return;
    }
    await delay(20);
  }
  const actual = await page.evaluate(() => document.visibilityState);
  throw new Error(
    `${label} did not expose actual document.visibilityState=${expected}; got ${actual}`,
  );
}

async function waitForExactlyOneFrame(page, hiddenFrameTotal, cycle) {
  const expected = hiddenFrameTotal + 1;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const snapshot = await readViewerSnapshot(page);
    const total = frameTotal(snapshot.diagnostics);
    invariant(
      total <= expected,
      `cycle ${cycle} completed more than one frame after becoming visible`,
    );
    if (total === expected && !snapshot.diagnostics.pendingAnimationFrame) {
      return snapshot;
    }
    await delay(20);
  }
  throw new Error(
    `cycle ${cycle} did not complete exactly one frame after becoming visible`,
  );
}

async function waitForTwoAnimationFrames(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }),
  );
}

function assertHealthyAndStable(snapshot, baseline, label) {
  invariant(snapshot.status === "ready", `${label} viewer status is not ready`);
  invariant(snapshot.sameCanvas === true, `${label} replaced the viewer canvas`);
  invariant(
    snapshot.diagnostics.recoveryAttempts === 0,
    `${label} unexpectedly attempted device recovery`,
  );
  for (const field of [
    "generation",
    "ownedListeners",
    "activeObservers",
    "activeRuntimes",
  ]) {
    invariant(
      snapshot.diagnostics[field] === baseline.diagnostics[field],
      `${label} changed stable ${field} ownership`,
    );
  }
}

function frameTotal(diagnostics) {
  return diagnostics.submittedFrames + diagnostics.skippedFrames;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
