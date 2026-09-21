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

test("real DOM display-none and zero-parent layouts suspend and recover for thirty cycles", async ({
  page,
  webgpuAvailability,
}) => {
  test.setTimeout(120_000);
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  const observations = await page.evaluate(async () => {
    const fixture = window.__forge3dInteractiveViewer;
    const viewer = await fixture.create({ resize: true });
    const canvas = fixture.canvas;
    const parent = canvas.parentElement!;
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const exercise = async (kind: "display-none" | "zero-parent") => {
      const cycles = [];
      for (let cycle = 1; cycle <= 30; cycle += 1) {
        const canvasStyle = canvas.getAttribute("style");
        const parentStyle = parent.getAttribute("style");
        if (kind === "display-none") canvas.style.display = "none";
        else {
          parent.style.width = "0px";
          parent.style.height = "0px";
          parent.style.minWidth = "0px";
          parent.style.padding = "0";
          parent.style.gap = "0";
          parent.style.gridTemplateColumns = "0px";
          parent.style.boxSizing = "border-box";
          parent.style.overflow = "hidden";
          canvas.style.width = "0px";
          canvas.style.height = "0px";
          canvas.style.border = "0";
        }
        let reachedZeroRect = false;
        for (let attempt = 0; attempt < 120; attempt += 1) {
          await frame();
          const rect = canvas.getBoundingClientRect();
          const parentRect = parent.getBoundingClientRect();
          const parentIsZero = kind === "display-none" || (parentRect.width === 0 && parentRect.height === 0);
          if (rect.width === 0 && rect.height === 0 && parentIsZero &&
              viewer.getDiagnostics().pendingAnimationFrame === false) {
            reachedZeroRect = true;
            break;
          }
        }
        if (!reachedZeroRect) {
          const rect = canvas.getBoundingClientRect();
          const parentRect = parent.getBoundingClientRect();
          throw new Error(`${kind} did not reach a suspended zero-area layout: ${JSON.stringify({
            canvas: [rect.width, rect.height],
            parent: [parentRect.width, parentRect.height],
            diagnostics: viewer.getDiagnostics(),
          })}`);
        }
        await frame();
        const hiddenBefore = viewer.getDiagnostics();
        const view = viewer.getView();
        viewer.setView({ ...view, yawDegrees: view.yawDegrees + 0.01 });
        await frame(); await frame(); await frame();
        const hiddenAfter = viewer.getDiagnostics();
        if (canvasStyle === null) canvas.removeAttribute("style");
        else canvas.setAttribute("style", canvasStyle);
        if (parentStyle === null) parent.removeAttribute("style");
        else parent.setAttribute("style", parentStyle);
        let recovered = viewer.getDiagnostics();
        for (let attempt = 0; attempt < 120 && recovered.submittedFrames <= hiddenAfter.submittedFrames; attempt += 1) {
          await frame();
          recovered = viewer.getDiagnostics();
        }
        cycles.push({
          hiddenSubmittedDelta: hiddenAfter.submittedFrames - hiddenBefore.submittedFrames,
          recovered: recovered.submittedFrames > hiddenAfter.submittedFrames,
          activeObservers: recovered.activeObservers,
          activeRuntimes: recovered.activeRuntimes,
          ownedAnimationFrameCount: recovered.ownedAnimationFrameCount,
        });
      }
      return cycles;
    };
    return {
      displayNone: await exercise("display-none"),
      zeroParent: await exercise("zero-parent"),
    };
  });
  for (const cycles of [observations.displayNone, observations.zeroParent]) {
    expect(cycles).toHaveLength(30);
    expect(cycles.every((cycle) => cycle.hiddenSubmittedDelta === 0)).toBe(true);
    expect(cycles.every((cycle) => cycle.recovered)).toBe(true);
    expect(cycles.every((cycle) => cycle.activeObservers === 1 && cycle.activeRuntimes === 1)).toBe(true);
    expect(cycles.every((cycle) => cycle.ownedAnimationFrameCount <= 1)).toBe(true);
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
    const cancelDescriptor = Object.getOwnPropertyDescriptor(
      prototype,
      "cancel",
    );
    const readDescriptor = Object.getOwnPropertyDescriptor(prototype, "read");
    const uint8ArrayDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "Uint8Array",
    );
    if (!cancelDescriptor || typeof cancelDescriptor.value !== "function") {
      throw new Error(
        "ReadableStreamDefaultReader.cancel descriptor is unavailable",
      );
    }
    if (!readDescriptor || typeof readDescriptor.value !== "function") {
      throw new Error(
        "ReadableStreamDefaultReader.read descriptor is unavailable",
      );
    }
    if (!uint8ArrayDescriptor) {
      throw new Error("Uint8Array descriptor is unavailable");
    }
    const originalCancel =
      cancelDescriptor.value as ReadableStreamDefaultReader<unknown>["cancel"];
    const originalRead =
      readDescriptor.value as ReadableStreamDefaultReader<unknown>["read"];
    const OriginalUint8Array = globalThis.Uint8Array;
    const overflowChunks = new WeakSet<object>();
    let cumulativeReceived = 0;
    let observedOverflowChunks = 0;
    let overflowChunkCopies = 0;
    Object.defineProperty(prototype, "read", {
      ...readDescriptor,
      value: function (this: ReadableStreamDefaultReader<unknown>) {
        return originalRead.call(this).then((readResult) => {
          const value = readResult.value;
          if (value instanceof OriginalUint8Array) {
            if (cumulativeReceived + value.byteLength > 16) {
              overflowChunks.add(value);
              observedOverflowChunks += 1;
            }
            cumulativeReceived += value.byteLength;
          }
          return readResult;
        });
      },
    });
    Object.defineProperty(globalThis, "Uint8Array", {
      ...uint8ArrayDescriptor,
      value: new Proxy(OriginalUint8Array, {
        construct(target, argumentsList, newTarget) {
          const source = argumentsList[0];
          if (
            typeof source === "object" &&
            source !== null &&
            overflowChunks.has(source)
          ) {
            overflowChunkCopies += 1;
          }
          return Reflect.construct(target, argumentsList, newTarget);
        },
      }),
    });
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
      ...cancelDescriptor,
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
      Object.defineProperty(globalThis, "Uint8Array", uint8ArrayDescriptor);
      Object.defineProperty(prototype, "read", readDescriptor);
      Object.defineProperty(prototype, "cancel", cancelDescriptor);
      viewer?.dispose();
    }
    return {
      code,
      cancelCalls,
      cancelSettlements,
      settledBeforeCancelGate,
      observedOverflowChunks,
      overflowChunkCopies,
    };
  });
  expect(result).toEqual({
    code: "IO_ERROR",
    cancelCalls: 1,
    cancelSettlements: ["fulfilled"],
    settledBeforeCancelGate: false,
    observedOverflowChunks: 1,
    overflowChunkCopies: 0,
  });
});

test("a malformed synthetic stream chunk is cancelled before terrain commit", async ({
  page,
  webgpuAvailability,
}) => {
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  const result = await page.evaluate(async () => {
    const viewer = await window.__forge3dInteractiveViewer.create();
    const readerPrototype = ReadableStreamDefaultReader.prototype;
    const readDescriptor = Object.getOwnPropertyDescriptor(
      readerPrototype,
      "read",
    );
    const cancelDescriptor = Object.getOwnPropertyDescriptor(
      readerPrototype,
      "cancel",
    );
    if (!readDescriptor || typeof readDescriptor.value !== "function") {
      throw new Error(
        "ReadableStreamDefaultReader.read descriptor is unavailable",
      );
    }
    if (!cancelDescriptor || typeof cancelDescriptor.value !== "function") {
      throw new Error(
        "ReadableStreamDefaultReader.cancel descriptor is unavailable",
      );
    }
    const coordinator = (globalThis as any)[
      Symbol.for("@forge3d/web.wasm-bridge-coordinator")
    ];
    const bridge = await coordinator?.record?.promise;
    const runtimePrototype = bridge?.Forge3DRuntime?.prototype;
    const terrainDescriptor = runtimePrototype
      ? Object.getOwnPropertyDescriptor(runtimePrototype, "setTerrain")
      : undefined;
    if (!terrainDescriptor || typeof terrainDescriptor.value !== "function") {
      throw new Error("Generated runtime setTerrain descriptor is unavailable");
    }
    const originalRead =
      readDescriptor.value as ReadableStreamDefaultReader<unknown>["read"];
    const originalCancel =
      cancelDescriptor.value as ReadableStreamDefaultReader<unknown>["cancel"];
    const originalSetTerrain = terrainDescriptor.value as (
      terrain: unknown,
    ) => void;
    let releaseCancelGate: () => void = () => {};
    const cancelGate = new Promise<void>((resolve) => {
      releaseCancelGate = resolve;
    });
    let notifyCancelCalled: () => void = () => {};
    const cancelCalled = new Promise<void>((resolve) => {
      notifyCancelCalled = resolve;
    });
    let yieldedMalformedChunk = false;
    let cancelCalls = 0;
    let terrainCommitCalls = 0;
    Object.defineProperty(readerPrototype, "read", {
      ...readDescriptor,
      value: function (this: ReadableStreamDefaultReader<unknown>) {
        return originalRead.call(this).then((readResult) => {
          if (!yieldedMalformedChunk && !readResult.done) {
            yieldedMalformedChunk = true;
            return {
              done: false,
              value: { fixture: "malformed-non-uint8array-chunk" },
            };
          }
          return readResult;
        });
      },
    });
    Object.defineProperty(readerPrototype, "cancel", {
      ...cancelDescriptor,
      value: function (
        this: ReadableStreamDefaultReader<unknown>,
        reason?: unknown,
      ) {
        cancelCalls += 1;
        notifyCancelCalled();
        return originalCancel.call(this, reason).then(async () => {
          await cancelGate;
        });
      },
    });
    Object.defineProperty(runtimePrototype, "setTerrain", {
      ...terrainDescriptor,
      value: function (this: unknown, terrain: unknown) {
        terrainCommitCalls += 1;
        return originalSetTerrain.call(this, terrain);
      },
    });

    let code: string | null = null;
    let settledBeforeCancelGate = true;
    try {
      const terrainOutcome = viewer
        .setTerrainFromSource({
          width: 2,
          height: 2,
          source: new Blob([new Uint8Array(16)]),
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
    } finally {
      releaseCancelGate();
      Object.defineProperty(runtimePrototype, "setTerrain", terrainDescriptor);
      Object.defineProperty(readerPrototype, "cancel", cancelDescriptor);
      Object.defineProperty(readerPrototype, "read", readDescriptor);
      viewer.dispose();
    }
    return {
      code,
      cancelCalls,
      yieldedMalformedChunk,
      settledBeforeCancelGate,
      terrainCommitCalls,
    };
  });
  expect(result).toEqual({
    code: "IO_ERROR",
    cancelCalls: 1,
    yieldedMalformedChunk: true,
    settledBeforeCancelGate: false,
    terrainCommitCalls: 0,
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
