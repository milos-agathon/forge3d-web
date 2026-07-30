import {
  expect,
  skipRenderAssertionsWhenProbing,
  test,
} from "../browser/webgpu-fixture";
import {
  exerciseViewerVisibilityLifecycle,
  VIEWER_VISIBILITY_LIFECYCLE_CYCLES,
} from "../browser/viewer-visibility-lifecycle.mjs";

test("creation, disposal, and retained getters follow the lifecycle contract", async ({
  page,
  webgpuAvailability,
}) => {
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  const result = await page.evaluate(async () => {
    const transitions: string[] = [];
    const viewer = await window.__forge3dInteractiveViewer.create({
      onStatusChange: ({ previous, current }: any) =>
        transitions.push(`${previous}->${current}`),
    });
    const viewBefore = viewer.getView();
    const capabilitiesBefore = viewer.getCapabilities();
    viewer.dispose();
    viewer.dispose();
    let disposedCode;
    try {
      viewer.render();
    } catch (error: any) {
      disposedCode = error.code;
    }
    return {
      transitions,
      status: viewer.status,
      disposed: viewer.disposed,
      viewBefore,
      viewAfter: viewer.getView(),
      capabilitiesBefore,
      capabilitiesAfter: viewer.getCapabilities(),
      diagnostics: viewer.getDiagnostics(),
      disposedCode,
    };
  });

  expect(result.transitions).toEqual([
    "initializing->ready",
    "ready->disposed",
  ]);
  expect(result.status).toBe("disposed");
  expect(result.disposed).toBe(true);
  expect(result.viewAfter).toEqual(result.viewBefore);
  expect(result.capabilitiesBefore.deviceState).toBe("ready");
  expect(result.capabilitiesAfter).toEqual({
    ...result.capabilitiesBefore,
    deviceState: "disposed",
  });
  expect(result.disposedCode).toBe("RUNTIME_DISPOSED");
  expect(result.diagnostics.ownedListeners).toBe(0);
  expect(result.diagnostics.activeObservers).toBe(0);
  expect(result.diagnostics.activeRuntimes).toBe(0);
  expect(result.diagnostics.pendingAnimationFrame).toBe(false);
});

test("visibility cycling preserves one viewer and resumes one frame", async (
  { context, page, webgpuAvailability },
  testInfo,
) => {
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  await page.evaluate(async () => {
    const errors: string[] = [];
    (window as any).__forge3dVisibilityLifecycleErrors = errors;
    await window.__forge3dInteractiveViewer.create({
      onError: (error: any) => errors.push(error.code ?? error.message),
    });
  });

  const headed = process.env.FORGE3D_HEADED === "1";
  let result;
  try {
    result = await exerciseViewerVisibilityLifecycle({
      page,
      context,
      headed,
      cycleCount: VIEWER_VISIBILITY_LIFECYCLE_CYCLES,
    });
  } catch (error) {
    await testInfo.attach("forge3d-viewer-visibility-lifecycle.json", {
      body: JSON.stringify(
        {
          mode: headed
            ? "headed-real-tab"
            : "deterministic-synthetic-document-visibility",
          error: error instanceof Error ? error.message : String(error),
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
    throw error;
  }
  await testInfo.attach("forge3d-viewer-visibility-lifecycle.json", {
    body: JSON.stringify(result, null, 2),
    contentType: "application/json",
  });

  expect(result.cycleCount).toBe(VIEWER_VISIBILITY_LIFECYCLE_CYCLES);
  expect(result.cycles).toHaveLength(VIEWER_VISIBILITY_LIFECYCLE_CYCLES);
  expect(result.sameCanvas).toBe(true);
  expect(result.orbitChangedView).toBe(true);
  expect(result.final.status).toBe("ready");
  expect(result.final.diagnostics.recoveryAttempts).toBe(0);
  expect(
    await page.evaluate(
      () => (window as any).__forge3dVisibilityLifecycleErrors,
    ),
  ).toEqual([]);
});

test("unsupported probe lanes expose structured UI without passing render assertions", async ({
  page,
  webgpuAvailability,
}) => {
  test.skip(
    webgpuAvailability.required ||
      (webgpuAvailability.hasNavigatorGpu &&
        webgpuAvailability.adapterAvailable),
    "negative unsupported UI applies only to an unavailable probe lane",
  );
  await page.evaluate(() =>
    window.__forge3dInteractiveViewer.create().catch(() => undefined),
  );
  await expect(page.locator("#unsupported")).toBeVisible();
  await expect(page.locator("#status")).toHaveText("unsupported");
});

declare global {
  interface Window {
    __forge3dInteractiveViewer: any;
  }
}
