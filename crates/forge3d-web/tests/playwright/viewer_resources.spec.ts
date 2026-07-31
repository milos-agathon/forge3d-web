import {
  expect,
  skipRenderAssertionsWhenProbing,
  test,
} from "../browser/webgpu-fixture";

test("desktop and mobile presets expose their exact effective budgets", async ({
  page,
  webgpuAvailability,
}) => {
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  const budgets = await page.evaluate(async () => {
    const desktop = await window.__forge3dInteractiveViewer.create({
      resources: { preset: "desktop" },
    });
    const desktopDiagnostics = desktop.getDiagnostics();
    desktop.dispose();
    const mobile = await window.__forge3dInteractiveViewer.create({
      resources: { preset: "mobile" },
    });
    return {
      desktop: desktopDiagnostics.effectiveResourceBudget,
      desktopDpr: desktopDiagnostics.effectiveMaxDevicePixelRatio,
      mobile: mobile.getDiagnostics().effectiveResourceBudget,
      mobileDpr: mobile.getDiagnostics().effectiveMaxDevicePixelRatio,
    };
  });

  expect(budgets.desktop).toEqual({
    maxTerrainSamples: 1_048_576,
    maxSourceBytes: 4_194_304,
    maxCanvasPixels: 8_294_400,
    maxScreenshotPixels: 8_294_400,
  });
  expect(budgets.mobile).toEqual({
    maxTerrainSamples: 262_144,
    maxSourceBytes: 1_048_576,
    maxCanvasPixels: 2_073_600,
    maxScreenshotPixels: 2_073_600,
  });
  expect(budgets.desktopDpr).toBe(2);
  expect(budgets.mobileDpr).toBe(2);
});

test("rejects oversized terrain before allocation", async ({
  page,
  webgpuAvailability,
}) => {
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  const result = await page.evaluate(async () => {
    const viewer = await window.__forge3dInteractiveViewer.create({
      resources: {
        budget: { maxTerrainSamples: 4096 },
      },
    });
    const before = viewer.getDiagnostics();
    let code;
    try {
      viewer.setTerrain({
        width: 65,
        height: 65,
        heights: new Float32Array(4225),
      });
    } catch (error: any) {
      code = error.code;
    }
    return { before, after: viewer.getDiagnostics(), code };
  });
  expect(result.code).toBe("RESOURCE_LIMIT_EXCEEDED");
  expect(result.after.submittedFrames).toBe(result.before.submittedFrames);
});

test("controls and automatic resize own only the documented resources", async ({
  page,
  webgpuAvailability,
}) => {
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  const diagnostics = await page.evaluate(async () => {
    const viewer = await window.__forge3dInteractiveViewer.create({
      controls: false,
      resize: false,
    });
    return viewer.getDiagnostics();
  });
  // Visibility and BFCache lifecycle handling remains owned even when input
  // controls and automatic resize are disabled.
  expect(diagnostics.ownedListeners).toBe(3);
  expect(diagnostics.activeObservers).toBe(0);
  expect(diagnostics.activeRuntimes).toBe(1);
});

test("fifty real viewers release every owned browser resource", async ({
  page,
  webgpuAvailability,
}) => {
  test.setTimeout(120_000);
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  const diagnostics = await page.evaluate(async () => {
    const snapshots = [];
    for (let index = 0; index < 50; index += 1) {
      const viewer = await window.__forge3dInteractiveViewer.create({
        controls: index % 2 === 0 ? { enabled: false } : {},
      });
      viewer.dispose();
      snapshots.push(viewer.getDiagnostics());
    }
    return snapshots;
  });
  for (const snapshot of diagnostics) {
    expect(snapshot.ownedListeners).toBe(0);
    expect(snapshot.activeObservers).toBe(0);
    expect(snapshot.activePointers).toBe(0);
    expect(snapshot.activeRuntimes).toBe(0);
    expect(snapshot.pendingAnimationFrame).toBe(false);
  }
});

test("disposal cancels a real streaming URL reader", async ({
  page,
  webgpuAvailability,
}) => {
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  const before = await page
    .request
    .get("/tests/slow-terrain-status")
    .then((response) => response.json());
  const result = await page.evaluate(async () => {
    const viewer = await window.__forge3dInteractiveViewer.create();
    const outcome = viewer
      .setTerrainFromSource({
        width: 2,
        height: 2,
        source: "/tests/slow-terrain.f32le",
      })
      .then(
        () => ({ code: null }),
        (error: any) => ({ code: error.code }),
      );
    await new Promise((resolve) => setTimeout(resolve, 100));
    viewer.dispose();
    return outcome;
  });
  expect(result.code).toBe("REQUEST_CANCELLED");
  await expect
    .poll(async () => {
      const response = await page.request.get("/tests/slow-terrain-status");
      const status = await response.json();
      return status.cancelledTerrainReaders;
    })
    .toBeGreaterThan(before.cancelledTerrainReaders);
});

test("an oversized real response cancels its browser stream reader", async ({
  page,
  webgpuAvailability,
}) => {
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  const result = await page.evaluate(async () => {
    const prototype = ReadableStreamDefaultReader.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(
      prototype,
      "cancel",
    );
    if (!descriptor || typeof descriptor.value !== "function") {
      throw new Error(
        "ReadableStreamDefaultReader.cancel descriptor is unavailable",
      );
    }
    const originalCancel =
      descriptor.value as ReadableStreamDefaultReader<unknown>["cancel"];
    const trackedCancelSettlements: Promise<"fulfilled" | "rejected">[] =
      [];
    let releaseCancelGate: () => void = () => {};
    const cancelGate = new Promise<void>((resolve) => {
      releaseCancelGate = resolve;
    });
    let notifyCancelCalled: () => void = () => {};
    const cancelCalled = new Promise<void>((resolve) => {
      notifyCancelCalled = resolve;
    });
    let cancelCalls = 0;
    Object.defineProperty(prototype, "cancel", {
      ...descriptor,
      value: function (
        this: ReadableStreamDefaultReader<unknown>,
        reason?: unknown,
      ) {
        cancelCalls += 1;
        notifyCancelCalled();
        const cancellation = originalCancel.call(this, reason).then(
          async () => {
            await cancelGate;
          },
          async (error) => {
            await cancelGate;
            throw error;
          },
        );
        trackedCancelSettlements.push(
          cancellation.then(
            () => "fulfilled" as const,
            () => "rejected" as const,
          ),
        );
        return cancellation;
      },
    });

    let viewer: any;
    let code: string | null = null;
    let settledBeforeCancelGate = true;
    let cancelSettlements: ("fulfilled" | "rejected")[] = [];
    try {
      viewer = await window.__forge3dInteractiveViewer.create();
      const terrainOutcome = viewer
        .setTerrainFromSource({
          width: 2,
          height: 2,
          source: "/tests/oversized-terrain.f32le",
        })
        .then(
          () => ({ code: null }),
          (error: any) => ({ code: error.code as string }),
        );
      await cancelCalled;
      settledBeforeCancelGate =
        (await Promise.race([
          terrainOutcome.then(() => "settled" as const),
          new Promise<"pending">((resolve) => {
            setTimeout(() => resolve("pending"), 0);
          }),
        ])) === "settled";
      releaseCancelGate();
      code = (await terrainOutcome).code;
      cancelSettlements = await Promise.all(
        trackedCancelSettlements,
      );
    } finally {
      releaseCancelGate();
      Object.defineProperty(prototype, "cancel", descriptor);
      viewer?.dispose();
    }
    return {
      code,
      cancelCalls,
      cancelSettlements,
      settledBeforeCancelGate,
    };
  });
  expect(result).toEqual({
    code: "IO_ERROR",
    cancelCalls: 1,
    cancelSettlements: ["fulfilled"],
    settledBeforeCancelGate: false,
  });
});

for (const sourceKind of ["Blob", "File"] as const) {
  test(`disposal invalidates and cancels a real ${sourceKind} stream`, async ({
    page,
    webgpuAvailability,
  }) => {
    skipRenderAssertionsWhenProbing(webgpuAvailability);
    const result = await page.evaluate(async (kind) => {
      const viewer = await window.__forge3dInteractiveViewer.create();
      const bytes = new Uint8Array(4_194_304);
      const source =
        kind === "File"
          ? new File([bytes], "terrain.f32le")
          : new Blob([bytes]);
      const outcome = viewer
        .setTerrainFromSource({
          width: 1024,
          height: 1024,
          source,
        })
        .then(
          () => ({ code: null }),
          (error: any) => ({ code: error.code }),
        );
      viewer.dispose();
      return outcome;
    }, sourceKind);
    expect(result.code).toBe("REQUEST_CANCELLED");
  });
}

declare global {
  interface Window {
    __forge3dInteractiveViewer: any;
  }
}
