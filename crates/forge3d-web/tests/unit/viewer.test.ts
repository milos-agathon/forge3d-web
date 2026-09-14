import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Forge3DError,
  type Forge3DRuntimeCapabilities,
  type Forge3DRuntimeOptions,
  type ResizeInput,
  type TerrainHeightmapInput,
  type TerrainHeightmapSourceInput,
} from "../../src-ts/index.js";
import {
  Forge3DViewer,
  setViewerRuntimeFactoryForTests,
} from "../../src-ts/viewer.js";

class FakeRuntime {
  disposed = false;
  disposeCalls = 0;
  width = 64;
  height = 64;
  renderCalls = 0;
  terrainCalls = 0;
  readonly terrains: TerrainHeightmapInput[] = [];
  cameraCalls = 0;
  resizeCalls = 0;
  sourceCalls = 0;
  readonly sources: TerrainHeightmapSourceInput[] = [];
  sourceAbortCount = 0;
  renderError: Forge3DError | undefined;
  cameraError: Forge3DError | undefined;
  resizeError: Forge3DError | undefined;
  renderSubmitted = true;
  screenshotError: Forge3DError | undefined;
  lossHandler: ((error: Forge3DError) => void) | undefined;
  loseDuringRegistration = false;
  loseAfterRegistrationMicrotask = false;
  readonly screenshotBlob = new Blob(["png"], { type: "image/png" });
  readonly sourceDeferred: Promise<void> | undefined;

  constructor(sourceDeferred?: Promise<void>) {
    this.sourceDeferred = sourceDeferred;
  }

  getCapabilities(): Forge3DRuntimeCapabilities {
    return {
      deviceState: this.disposed ? "disposed" : "ready",
      maxTextureDimension2D: 4096,
      maxBufferSize: 1_000_000_000,
      surfaceFormat: "bgra8unorm-srgb",
    };
  }

  setDeviceLostHandler(
    handler: ((error: Forge3DError) => void) | undefined,
  ): void {
    this.lossHandler = handler;
    if (handler !== undefined && this.loseDuringRegistration) {
      this.loseDuringRegistration = false;
      handler(new Forge3DError("DEVICE_LOST", "synchronous registration loss"));
    }
    if (handler !== undefined && this.loseAfterRegistrationMicrotask) {
      this.loseAfterRegistrationMicrotask = false;
      queueMicrotask(() => {
        handler(new Forge3DError("DEVICE_LOST", "microtask registration loss"));
      });
    }
  }

  lose(): void {
    this.lossHandler?.(new Forge3DError("DEVICE_LOST", "test loss"));
  }

  setTerrain(terrain: TerrainHeightmapInput): void {
    this.terrainCalls += 1;
    this.terrains.push(terrain);
  }

  async setTerrainFromSource(
    terrain: TerrainHeightmapSourceInput,
  ): Promise<void> {
    this.sourceCalls += 1;
    this.sources.push(terrain);
    terrain.onProgress?.({ loaded: 16, total: 16, done: true });
    if (this.sourceDeferred === undefined) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        this.sourceAbortCount += 1;
        reject(new Forge3DError("REQUEST_CANCELLED", "source aborted"));
      };
      if (terrain.signal?.aborted) {
        abort();
        return;
      }
      terrain.signal?.addEventListener("abort", abort, { once: true });
      this.sourceDeferred.then(
        () => {
          terrain.signal?.removeEventListener("abort", abort);
          resolve();
        },
        reject,
      );
    });
  }

  setCamera(): void {
    if (this.cameraError !== undefined) {
      throw this.cameraError;
    }
    this.cameraCalls += 1;
  }

  resize(size: ResizeInput): void {
    if (this.resizeError !== undefined) {
      throw this.resizeError;
    }
    this.resizeCalls += 1;
    this.width = Math.round(size.width * size.devicePixelRatio);
    this.height = Math.round(size.height * size.devicePixelRatio);
  }

  render(): boolean {
    if (this.renderError !== undefined) {
      throw this.renderError;
    }
    this.renderCalls += 1;
    return this.renderSubmitted;
  }

  screenshot(): Promise<Blob> {
    if (this.screenshotError !== undefined) {
      return Promise.reject(this.screenshotError);
    }
    return Promise.resolve(this.screenshotBlob);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposeCalls += 1;
    this.disposed = true;
    this.lossHandler = undefined;
  }
}

describe("Forge3DViewer", () => {
  let rafCallbacks: FrameRequestCallback[];

  beforeEach(() => {
    setViewerRuntimeFactoryForTests(undefined);
    rafCallbacks = [];
    vi.stubGlobal(
      "requestAnimationFrame",
      (callback: FrameRequestCallback): number => {
        rafCallbacks.push(callback);
        return rafCallbacks.length;
      },
    );
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.stubGlobal(
      "window",
      Object.assign(new EventTarget(), { devicePixelRatio: 1 }),
    );
  });

  afterEach(() => {
    setViewerRuntimeFactoryForTests(undefined);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("creates with viewer power semantics and coalesces invalidations", async () => {
    const runtimes: FakeRuntime[] = [];
    const optionsSeen: Forge3DRuntimeOptions[] = [];
    const statuses: string[] = [];
    setViewerRuntimeFactoryForTests({
      create: async (_canvas, options) => {
        optionsSeen.push(options);
        const runtime = new FakeRuntime();
        runtimes.push(runtime);
        return runtime;
      },
    });
    const viewer = await Forge3DViewer.create({} as HTMLCanvasElement, {
        controls: false,
        resize: false,
        onStatusChange: ({ previous, current }) =>
          statuses.push(`${previous}->${current}`),
      });

    expect(optionsSeen[0]?.powerPreference).toBe("none");
    expect(statuses).toEqual(["initializing->ready"]);
    viewer.render();
    viewer.render();
    expect(rafCallbacks).toHaveLength(1);
    rafCallbacks.shift()?.(0);
    expect(runtimes[0]?.renderCalls).toBe(1);
    expect(viewer.getDiagnostics().submittedFrames).toBe(1);
  });

  it("coordinates authoritative resize measurements with BFCache restore", async () => {
    const runtime = new FakeRuntime();
    const canvas = new FakeViewerCanvas();
    canvas.cssWidth = 320.5;
    canvas.cssHeight = 180.25;
    const frames = new FakeViewerAnimationFrames();
    const observers = installViewerResizeObserver(true);
    vi.stubGlobal("requestAnimationFrame", frames.request);
    vi.stubGlobal("cancelAnimationFrame", frames.cancel);
    vi.stubGlobal("devicePixelRatio", 1.5);
    setViewerRuntimeFactoryForTests({ create: async () => runtime });

    const viewer = await Forge3DViewer.create(
      canvas as unknown as HTMLCanvasElement,
      { controls: false },
    );
    expect(runtime.resizeCalls).toBe(1);
    expect([runtime.width, runtime.height]).toEqual([480, 270]);
    expect(frames.pending).toBe(1);
    frames.flush();
    expect(runtime.renderCalls).toBe(1);
    expect(viewer.getDiagnostics().submittedFrames).toBe(1);
    expect(frames.pending).toBe(0);
    const observer = observers.instances[0];
    expect(observer).toBeDefined();

    let before = viewerEventCounts(viewer, runtime);
    canvas.cssWidth = 321.5;
    const bootstrapObserveCalls = observer?.observeCalls.length ?? 0;
    window.dispatchEvent(new Event("resize"));
    expectNoResizeOrFrame(viewer, runtime, frames, before);
    expect(observer?.observeCalls).toHaveLength(bootstrapObserveCalls + 2);
    observer?.deliver(canvas, 321.5, 180.25);
    flushResizeTransition(viewer, runtime, frames, before, [482, 270]);

    before = viewerEventCounts(viewer, runtime);
    vi.stubGlobal("devicePixelRatio", 1);
    canvas.cssWidth = 400;
    canvas.cssHeight = 300;
    window.dispatchEvent(new Event("resize"));
    expectNoResizeOrFrame(viewer, runtime, frames, before);
    observer?.deliver(canvas, 400, 300, 400, 300);
    flushResizeTransition(viewer, runtime, frames, before, [400, 300]);

    before = viewerEventCounts(viewer, runtime);
    vi.stubGlobal("devicePixelRatio", 1.5);
    const dprObserveCalls = observer?.observeCalls.length ?? 0;
    window.dispatchEvent(new Event("resize"));
    expectNoResizeOrFrame(viewer, runtime, frames, before);
    expect(observer?.observeCalls).toHaveLength(dprObserveCalls + 2);
    window.dispatchEvent(new Event("resize"));
    expectNoResizeOrFrame(viewer, runtime, frames, before);
    expect(observer?.observeCalls).toHaveLength(dprObserveCalls + 2);
    observer?.deliver(canvas, 400, 300, 600, 450);
    flushResizeTransition(viewer, runtime, frames, before, [600, 450]);

    before = viewerEventCounts(viewer, runtime);
    canvas.cssWidth = 300;
    canvas.cssHeight = 400;
    window.dispatchEvent(new Event("resize"));
    expectNoResizeOrFrame(viewer, runtime, frames, before);
    observer?.deliver(canvas, 300, 400, 450, 600);
    flushResizeTransition(viewer, runtime, frames, before, [450, 600]);

    before = viewerEventCounts(viewer, runtime);
    canvas.cssWidth = 100.5;
    canvas.cssHeight = 50.5;
    observer?.deliver(canvas, 100.5, 50.5, 150, 75);
    flushResizeTransition(viewer, runtime, frames, before, [149, 75]);

    const authoritativeCalls = runtime.resizeCalls;
    observer?.deliver(canvas, 100.5, 50.5, 150, 75);
    window.dispatchEvent(new Event("resize"));
    expect(runtime.resizeCalls).toBe(authoritativeCalls);
    expect(frames.pending).toBe(0);

    before = viewerEventCounts(viewer, runtime);
    canvas.cssWidth = 101.5;
    canvas.cssHeight = 51.5;
    const reconcileObserveCalls = observer?.observeCalls.length ?? 0;
    window.dispatchEvent(new Event("resize"));
    expectNoResizeOrFrame(viewer, runtime, frames, before);
    expect(observer?.observeCalls).toHaveLength(reconcileObserveCalls + 2);
    window.dispatchEvent(new Event("resize"));
    expectNoResizeOrFrame(viewer, runtime, frames, before);
    expect(observer?.observeCalls).toHaveLength(reconcileObserveCalls + 2);
    observer?.deliver(canvas, 101.5, 51.5, 152, 77);
    flushResizeTransition(viewer, runtime, frames, before, [151, 77]);
    const reconciled = viewerEventCounts(viewer, runtime);
    observer?.deliver(canvas, 101.5, 51.5, 152, 77);
    window.dispatchEvent(new Event("resize"));
    expectNoResizeOrFrame(viewer, runtime, frames, reconciled);

    before = viewerEventCounts(viewer, runtime);
    canvas.cssWidth = 100.5;
    canvas.cssHeight = 50.5;
    observer?.deliver(canvas, 100.5, 50.5, 150, 75);
    flushResizeTransition(viewer, runtime, frames, before, [149, 75]);

    window.dispatchEvent(pageTransitionEvent("pagehide", true));
    const resizeCalls = runtime.resizeCalls;
    observer?.deliver(canvas, 101.5, 51.5, 152, 77);
    window.dispatchEvent(new Event("resize"));
    expect(runtime.resizeCalls).toBe(resizeCalls);
    const observeCallsBeforeRestore = observer?.observeCalls.length ?? 0;
    const disconnectsBeforeRestore = observer?.disconnectCalls ?? 0;
    window.dispatchEvent(pageTransitionEvent("pageshow", true));

    expect(runtime.resizeCalls).toBe(resizeCalls);
    expect(frames.pending).toBe(0);
    expect(observer?.disconnectCalls).toBe(disconnectsBeforeRestore + 1);
    expect(observer?.observeCalls).toHaveLength(observeCallsBeforeRestore + 2);
    expect(observer?.observeCalls.every(({ target }) => target === canvas)).toBe(
      true,
    );
    expect(observer?.observeCalls.slice(-2).map(({ options }) => options?.box)).toEqual(
      ["device-pixel-content-box", undefined],
    );
    observer?.deliver(canvas, 0, 0);
    window.dispatchEvent(new Event("resize"));
    expect(runtime.resizeCalls).toBe(resizeCalls);
    expect(frames.pending).toBe(0);
    const unchangedRestore = viewerEventCounts(viewer, runtime);
    observer?.deliver(canvas, 100.5, 50.5, 150, 75);
    expect(runtime.resizeCalls).toBe(unchangedRestore.resizeCalls + 1);
    observer?.deliver(canvas, 100.5, 50.5, 150, 75);
    flushResizeTransition(
      viewer,
      runtime,
      frames,
      unchangedRestore,
      [149, 75],
    );

    window.dispatchEvent(pageTransitionEvent("pagehide", true));
    canvas.cssWidth = 101.5;
    canvas.cssHeight = 51.5;
    observer?.deliver(canvas, 101.5, 51.5, 152, 77);
    expect(runtime.resizeCalls).toBe(resizeCalls + 1);
    const observeCallsBeforeChangedRestore =
      observer?.observeCalls.length ?? 0;
    window.dispatchEvent(pageTransitionEvent("pageshow", true));
    expect(observer?.observeCalls).toHaveLength(
      observeCallsBeforeChangedRestore + 2,
    );
    const changedRestore = viewerEventCounts(viewer, runtime);
    observer?.deliver(canvas, 101.5, 51.5, 152, 77);
    expect(runtime.resizeCalls).toBe(changedRestore.resizeCalls + 1);
    observer?.deliver(canvas, 101.5, 51.5, 152, 77);
    flushResizeTransition(viewer, runtime, frames, changedRestore, [151, 77]);

    before = viewerEventCounts(viewer, runtime);
    canvas.cssWidth = 120.5;
    canvas.cssHeight = 60.5;
    observer?.deliver(canvas, 120.5, 60.5);
    flushResizeTransition(viewer, runtime, frames, before, [180, 90]);
    const rawCalls = runtime.resizeCalls;
    window.dispatchEvent(new Event("resize"));
    expect(runtime.resizeCalls).toBe(rawCalls);
    before = viewerEventCounts(viewer, runtime);
    canvas.cssWidth = 121.5;
    window.dispatchEvent(new Event("resize"));
    expectNoResizeOrFrame(viewer, runtime, frames, before);
    observer?.deliver(canvas, 121.5, 60.5);
    flushResizeTransition(viewer, runtime, frames, before, [182, 90]);
    before = viewerEventCounts(viewer, runtime);
    vi.stubGlobal("devicePixelRatio", 1);
    window.dispatchEvent(new Event("resize"));
    expectNoResizeOrFrame(viewer, runtime, frames, before);
    observer?.deliver(canvas, 121.5, 60.5);
    flushResizeTransition(viewer, runtime, frames, before, [121, 60]);

    before = viewerEventCounts(viewer, runtime);
    canvas.cssWidth = 121.6;
    canvas.cssHeight = 60.6;
    window.dispatchEvent(new Event("resize"));
    expectNoResizeOrFrame(viewer, runtime, frames, before);
    viewer.render();
    expect(frames.pending).toBe(0);
    observer?.deliver(canvas, 121.6, 60.6);
    expect(runtime.resizeCalls).toBe(before.resizeCalls);
    expect(runtime.renderCalls).toBe(before.renderCalls);
    expect(frames.pending).toBe(1);
    frames.flush();
    expect(runtime.renderCalls).toBe(before.renderCalls + 1);
    expect(viewer.getDiagnostics().submittedFrames).toBe(
      before.submittedFrames + 1,
    );
    expect(frames.pending).toBe(0);

    const ordinary = viewerEventCounts(viewer, runtime);
    window.dispatchEvent(pageTransitionEvent("pageshow", false));
    expect(runtime.resizeCalls).toBe(ordinary.resizeCalls);
    expect(frames.pending).toBe(1);
    frames.flush();
    expect(runtime.renderCalls).toBe(ordinary.renderCalls + 1);
    expect(viewer.getDiagnostics().submittedFrames).toBe(
      ordinary.submittedFrames + 1,
    );
    expect(frames.pending).toBe(0);

    const ownership = viewer.getDiagnostics();
    for (let cycle = 0; cycle < 3; cycle += 1) {
      window.dispatchEvent(pageTransitionEvent("pagehide", true));
      window.dispatchEvent(pageTransitionEvent("pageshow", true));
      before = viewerEventCounts(viewer, runtime);
      observer?.deliver(canvas, 121.6, 60.6);
      flushResizeTransition(viewer, runtime, frames, before, [121, 60]);
      expect(viewer.getDiagnostics()).toMatchObject({
        ownedListeners: ownership.ownedListeners,
        activeObservers: 1,
      });
    }
    viewer.dispose();
    expect(viewer.getDiagnostics()).toMatchObject({
      ownedListeners: 0,
      activeObservers: 0,
      pendingAnimationFrame: false,
    });
    const disposedCalls = runtime.resizeCalls;
    observer?.deliver(canvas, 200, 100, 200, 100);
    window.dispatchEvent(new Event("resize"));
    window.dispatchEvent(pageTransitionEvent("pageshow", true));
    expect(runtime.resizeCalls).toBe(disposedCalls);
    expect(frames.pending).toBe(0);
  });

  it("uses fresh rectangle fallback after persisted restore without an observer", async () => {
    const runtime = new FakeRuntime();
    const canvas = new FakeViewerCanvas();
    const frames = new FakeViewerAnimationFrames();
    vi.stubGlobal("ResizeObserver", undefined);
    vi.stubGlobal("requestAnimationFrame", frames.request);
    vi.stubGlobal("cancelAnimationFrame", frames.cancel);
    vi.stubGlobal("devicePixelRatio", 1);
    setViewerRuntimeFactoryForTests({ create: async () => runtime });
    const viewer = await Forge3DViewer.create(
      canvas as unknown as HTMLCanvasElement,
      { controls: false },
    );
    frames.flush();

    let before = viewerEventCounts(viewer, runtime);
    window.dispatchEvent(pageTransitionEvent("pagehide", true));
    canvas.cssWidth = 200;
    canvas.cssHeight = 100;
    window.dispatchEvent(pageTransitionEvent("pageshow", true));
    flushResizeTransition(viewer, runtime, frames, before, [200, 100]);

    window.dispatchEvent(pageTransitionEvent("pagehide", true));
    canvas.cssWidth = 0;
    canvas.cssHeight = 0;
    const hiddenCalls = runtime.resizeCalls;
    window.dispatchEvent(pageTransitionEvent("pageshow", true));
    expect(runtime.resizeCalls).toBe(hiddenCalls);
    expect(frames.pending).toBe(0);
    window.dispatchEvent(new Event("resize"));
    expect(runtime.resizeCalls).toBe(hiddenCalls);
    canvas.cssWidth = 240;
    canvas.cssHeight = 120;
    before = viewerEventCounts(viewer, runtime);
    window.dispatchEvent(new Event("resize"));
    flushResizeTransition(viewer, runtime, frames, before, [240, 120]);
    viewer.dispose();
  });

  it("coalesces control updates and cancels the exact hidden-page frame", async () => {
    const runtime = new FakeRuntime();
    const canvas = new FakeViewerCanvas();
    const frames = new FakeViewerAnimationFrames();
    vi.stubGlobal("requestAnimationFrame", frames.request);
    vi.stubGlobal("cancelAnimationFrame", frames.cancel);
    setViewerRuntimeFactoryForTests({ create: async () => runtime });
    const viewer = await Forge3DViewer.create(
      canvas as unknown as HTMLCanvasElement,
      { resize: false },
    );
    frames.flush();
    const initialView = viewer.getView();
    const initialCameraCalls = runtime.cameraCalls;
    const initialRenders = runtime.renderCalls;

    canvas.dispatchEvent(pointerEvent("pointerdown", 1, 100, 100));
    for (let index = 1; index <= 100; index += 1) {
      canvas.dispatchEvent(pointerEvent("pointermove", 1, 100 + index, 100));
    }
    expect(viewer.getView()).not.toEqual(initialView);
    expect(runtime.cameraCalls).toBe(initialCameraCalls + 100);
    expect(runtime.renderCalls).toBe(initialRenders);
    expect(frames.pending).toBe(1);
    frames.flush();
    expect(runtime.renderCalls).toBe(initialRenders + 1);

    viewer.render();
    const pendingHandle = frames.pendingHandles[0];
    expect(pendingHandle).toBeDefined();
    window.dispatchEvent(pageTransitionEvent("pagehide", true));
    expect(frames.cancelled).toContain(pendingHandle);
    expect(frames.pending).toBe(0);
    viewer.render();
    expect(frames.pending).toBe(0);
    viewer.dispose();
    window.dispatchEvent(pageTransitionEvent("pageshow", true));
    canvas.dispatchEvent(pointerEvent("pointermove", 1, 250, 100));
    expect(frames.pending).toBe(0);
    expect(viewer.getDiagnostics()).toMatchObject({
      activePointers: 0,
      ownedListeners: 0,
      activeObservers: 0,
      pendingAnimationFrame: false,
    });
  });

  it.each([
    ["none", "none"],
    ["low-power", "low-power"],
    ["high-performance", "high-performance"],
  ] as const)(
    "preserves explicit viewer power preference %s",
    async (powerPreference, expected) => {
      const optionsSeen: Forge3DRuntimeOptions[] = [];
      setViewerRuntimeFactoryForTests({
        create: async (_canvas, options) => {
          optionsSeen.push(options);
          return new FakeRuntime();
        },
      });

      const viewer = await Forge3DViewer.create({} as HTMLCanvasElement, {
        controls: false,
        resize: false,
        runtime: { powerPreference },
      });

      expect(optionsSeen).toHaveLength(1);
      expect(optionsSeen[0]?.powerPreference).toBe(expected);
      viewer.dispose();
    },
  );

  it("rejects policy violations before calling the runtime", async () => {
    const runtime = new FakeRuntime();
    const viewer = await createViewer(runtime, {
      resources: { budget: { maxTerrainSamples: 4 } },
    });
    expect(() =>
      viewer.setTerrain({
        width: 3,
        height: 2,
        heights: new Float32Array(6),
      }),
    ).toThrowError(
      expect.objectContaining({ code: "RESOURCE_LIMIT_EXCEEDED" }),
    );
    expect(runtime.terrainCalls).toBe(0);
  });

  it("rejects an oversized color ramp before cloning or runtime allocation", async () => {
    const runtime = new FakeRuntime();
    const viewer = await createViewer(runtime);
    expect(() =>
      viewer.setTerrain({
        width: 2,
        height: 2,
        heights: new Float32Array(4),
        colorRamp: {
          stops: Array.from({ length: 9 }, (_, index) => ({
            position: index / 8,
            color: [0, 0, 0] as [number, number, number],
          })),
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(runtime.terrainCalls).toBe(0);
  });

  it("counts native skipped frames without manufacturing submissions", async () => {
    const runtime = new FakeRuntime();
    runtime.renderSubmitted = false;
    const viewer = await createViewer(runtime);
    rafCallbacks.shift()?.(0);
    expect(viewer.getDiagnostics().submittedFrames).toBe(0);
    expect(viewer.getDiagnostics().skippedFrames).toBe(1);
  });

  it("awaits synchronous startup loss and initializes only the replacement", async () => {
    const first = new FakeRuntime();
    first.loseDuringRegistration = true;
    const replacement = new FakeRuntime();
    let releaseReplacement!: () => void;
    const replacementReady = new Promise<void>((resolve) => {
      releaseReplacement = resolve;
    });
    const statuses: string[] = [];
    const errors: string[] = [];
    let creates = 0;
    setViewerRuntimeFactoryForTests({
      create: async () => {
        creates += 1;
        if (creates === 1) return first;
        await replacementReady;
        return replacement;
      },
    });

    let settled = false;
    const creation = Forge3DViewer.create({} as HTMLCanvasElement, {
      controls: false,
      resize: false,
      onStatusChange: ({ previous, current }) =>
        statuses.push(`${previous}->${current}`),
      onError: (error) => errors.push(error.code),
    });
    void creation.finally(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(creates).toBe(2));
    expect(settled).toBe(false);
    expect(first.disposed).toBe(true);
    expect(first.disposeCalls).toBe(1);
    expect(first.cameraCalls).toBe(0);
    expect(statuses).toEqual(["initializing->recovering"]);

    releaseReplacement();
    const viewer = await creation;
    expect(viewer.status).toBe("ready");
    expect(viewer.getDiagnostics()).toMatchObject({
      generation: 2,
      recoveryAttempts: 1,
      activeRuntimes: 1,
    });
    expect(replacement.disposed).toBe(false);
    expect(replacement.cameraCalls).toBeGreaterThan(0);
    expect(errors).toEqual(["DEVICE_LOST"]);
    expect(statuses).toEqual([
      "initializing->recovering",
      "recovering->ready",
    ]);
  });

  it("awaits a microtask startup loss before operating on the runtime", async () => {
    const first = new FakeRuntime();
    first.loseAfterRegistrationMicrotask = true;
    const replacement = new FakeRuntime();
    let releaseReplacement!: () => void;
    const replacementReady = new Promise<void>((resolve) => {
      releaseReplacement = resolve;
    });
    const statuses: string[] = [];
    let creates = 0;
    setViewerRuntimeFactoryForTests({
      create: async () => {
        creates += 1;
        if (creates === 1) return first;
        await replacementReady;
        return replacement;
      },
    });

    let settled = false;
    const creation = Forge3DViewer.create({} as HTMLCanvasElement, {
      controls: false,
      resize: false,
      onStatusChange: ({ previous, current }) =>
        statuses.push(`${previous}->${current}`),
    });
    void creation.finally(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(creates).toBe(2));
    expect(settled).toBe(false);
    expect(first.disposed).toBe(true);
    expect(first.disposeCalls).toBe(1);
    expect(first.cameraCalls).toBe(0);
    expect(first.resizeCalls).toBe(0);
    expect(first.terrainCalls).toBe(0);
    expect(first.renderCalls).toBe(0);
    expect(statuses).toEqual(["initializing->recovering"]);

    releaseReplacement();
    const viewer = await creation;
    expect(viewer.status).toBe("ready");
    expect(viewer.getDiagnostics()).toMatchObject({
      generation: 2,
      recoveryAttempts: 1,
      activeRuntimes: 1,
    });
    expect(replacement.disposed).toBe(false);
    expect(statuses).toEqual([
      "initializing->recovering",
      "recovering->ready",
    ]);

    viewer.dispose();
    expect(viewer.getDiagnostics().activeRuntimes).toBe(0);
    expect(replacement.disposeCalls).toBe(1);
  });

  it("rejects startup when the synchronous-loss replacement fails", async () => {
    const first = new FakeRuntime();
    first.loseDuringRegistration = true;
    const replacement = new FakeRuntime();
    replacement.cameraError = new Forge3DError(
      "INVALID_INPUT",
      "replacement initialization failed",
    );
    let releaseReplacement!: () => void;
    const replacementReady = new Promise<void>((resolve) => {
      releaseReplacement = resolve;
    });
    const statuses: string[] = [];
    let creates = 0;
    setViewerRuntimeFactoryForTests({
      create: async () => {
        creates += 1;
        if (creates === 1) return first;
        await replacementReady;
        return replacement;
      },
    });

    let settled = false;
    const creation = Forge3DViewer.create({} as HTMLCanvasElement, {
      controls: false,
      resize: false,
      onStatusChange: ({ previous, current }) =>
        statuses.push(`${previous}->${current}`),
    });
    void creation.catch(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(creates).toBe(2));
    expect(settled).toBe(false);
    expect(statuses).toEqual(["initializing->recovering"]);
    releaseReplacement();
    await expect(creation).rejects.toMatchObject({ code: "DEVICE_LOST" });
    expect(settled).toBe(true);
    expect(first.disposeCalls).toBe(1);
    expect(replacement.disposeCalls).toBe(1);
    expect(statuses).toEqual([
      "initializing->recovering",
      "recovering->failed",
    ]);
  });

  it("routes operational device loss into recovery", async () => {
    const first = new FakeRuntime();
    first.renderError = new Forge3DError("DEVICE_LOST", "operational loss");
    const second = new FakeRuntime();
    const runtimes = [first, second];
    let index = 0;
    setViewerRuntimeFactoryForTests({
      create: async () => runtimes[index++] as FakeRuntime,
    });
    const viewer = await Forge3DViewer.create({} as HTMLCanvasElement, {
      controls: false,
      resize: false,
    });
    rafCallbacks.shift()?.(0);
    await vi.waitFor(() => expect(viewer.status).toBe("ready"));
    expect(index).toBe(2);
    expect(viewer.getDiagnostics().recoveryAttempts).toBe(1);
  });

  it("routes screenshot camera synchronization loss into recovery", async () => {
    const first = new FakeRuntime();
    const second = new FakeRuntime();
    const runtimes = [first, second];
    let index = 0;
    setViewerRuntimeFactoryForTests({
      create: async () => runtimes[index++] as FakeRuntime,
    });
    const viewer = await Forge3DViewer.create({} as HTMLCanvasElement, {
      controls: false,
      resize: false,
    });
    first.cameraError = new Forge3DError(
      "DEVICE_LOST",
      "camera synchronization loss",
    );
    expect(() => viewer.screenshot()).toThrowError(
      expect.objectContaining({ code: "DEVICE_LOST" }),
    );
    await vi.waitFor(() => expect(viewer.status).toBe("ready"));
    expect(index).toBe(2);
    expect(viewer.getDiagnostics().recoveryAttempts).toBe(1);
  });

  it("routes control-driven camera loss into recovery", async () => {
    const first = new FakeRuntime();
    const second = new FakeRuntime();
    const runtimes = [first, second];
    let index = 0;
    setViewerRuntimeFactoryForTests({
      create: async () => runtimes[index++] as FakeRuntime,
    });
    const canvas = new FakeViewerCanvas();
    const viewer = await Forge3DViewer.create(
      canvas as unknown as HTMLCanvasElement,
      { resize: false },
    );
    first.cameraError = new Forge3DError("DEVICE_LOST", "control loss");
    canvas.dispatchEvent(pointerEvent("pointerdown", 1, 100, 100));
    canvas.dispatchEvent(pointerEvent("pointermove", 1, 130, 90));
    await vi.waitFor(() => expect(viewer.status).toBe("ready"));
    expect(index).toBe(2);
    expect(viewer.getDiagnostics().recoveryAttempts).toBe(1);
  });

  it("routes automatic resize loss into recovery", async () => {
    const first = new FakeRuntime();
    const second = new FakeRuntime();
    const runtimes = [first, second];
    let index = 0;
    setViewerRuntimeFactoryForTests({
      create: async () => runtimes[index++] as FakeRuntime,
    });
    const canvas = new FakeViewerCanvas();
    const viewer = await Forge3DViewer.create(
      canvas as unknown as HTMLCanvasElement,
      { controls: false },
    );
    first.resizeError = new Forge3DError("DEVICE_LOST", "observer loss");
    canvas.cssWidth = 401;
    window.dispatchEvent(new Event("resize"));
    await vi.waitFor(() => expect(viewer.status).toBe("ready"));
    expect(index).toBe(2);
    expect(viewer.getDiagnostics().recoveryAttempts).toBe(1);
  });

  it("handles rejected screenshot cleanup without an unhandled branch", async () => {
    const runtime = new FakeRuntime();
    runtime.screenshotError = new Forge3DError(
      "RUNTIME_DISPOSED",
      "disposed during screenshot",
    );
    const viewer = await createViewer(runtime);
    await expect(viewer.screenshot()).rejects.toMatchObject({
      code: "RUNTIME_DISPOSED",
    });
    await Promise.resolve();
    expect(viewer.getDiagnostics().screenshotInFlight).toBe(false);
  });

  it("shares one screenshot promise and preserves legal disposal getters", async () => {
    const runtime = new FakeRuntime();
    const viewer = await createViewer(runtime);
    const first = viewer.screenshot();
    const second = viewer.screenshot();
    expect(second).toBe(first);
    expect(await first).toBe(runtime.screenshotBlob);

    const view = viewer.getView();
    viewer.dispose();
    viewer.dispose();
    expect(viewer.status).toBe("disposed");
    expect(viewer.getView()).toEqual(view);
    expect(viewer.getCapabilities().deviceState).toBe("disposed");
    expect(viewer.getDiagnostics().activeRuntimes).toBe(0);
    expect(() => viewer.render()).toThrowError(
      expect.objectContaining({ code: "RUNTIME_DISPOSED" }),
    );
  });

  it("reuses the latest viewer-owned direct terrain snapshot during recovery", async () => {
    const runtimes = [new FakeRuntime(), new FakeRuntime()];
    let index = 0;
    const errors: string[] = [];
    setViewerRuntimeFactoryForTests({
      create: async () => {
        const runtime = runtimes[index];
        index += 1;
        if (runtime === undefined) {
          throw new Error("unexpected third runtime");
        }
        return runtime;
      },
    });
    const viewer = await Forge3DViewer.create({} as HTMLCanvasElement, {
        controls: false,
        resize: false,
        onError: (error) => errors.push(error.code),
      });
    const callerHeights = new Float32Array([2, 3, 5, 7]);
    try {
      viewer.setTerrain({
        width: 2,
        height: 2,
        heights: new Float32Array([0, 1, 1, 0]),
      });
      viewer.setTerrain({ width: 2, height: 2, heights: callerHeights });
      const committed = runtimes[0]?.terrains[1];
      expect(committed?.heights).not.toBe(callerHeights);
      expect(Array.from(committed?.heights ?? [])).toEqual([2, 3, 5, 7]);
      callerHeights.fill(99);

      runtimes[0]?.lose();
      await vi.waitFor(() => expect(viewer.status).toBe("ready"));
      expect(index).toBe(2);
      expect(runtimes[1]?.terrains).toHaveLength(1);
      expect(runtimes[1]?.terrains[0]).toBe(committed);
      expect(runtimes[1]?.terrains[0]?.heights).toBe(committed?.heights);
      expect(Array.from(runtimes[1]?.terrains[0]?.heights ?? [])).toEqual([
        2, 3, 5, 7,
      ]);
      expect(viewer.getDiagnostics().recoveryAttempts).toBe(1);

      runtimes[1]?.lose();
      expect(viewer.status).toBe("failed");
      expect(errors).toEqual(["DEVICE_LOST", "DEVICE_LOST"]);
      expect(viewer.getDiagnostics().activeRuntimes).toBe(0);
    } finally {
      viewer.dispose();
    }
  });

  const replayableSources: Array<{
    name: string;
    create: () => TerrainHeightmapSourceInput["source"];
  }> = [
    { name: "URL string", create: () => "https://example.test/terrain.bin" },
    {
      name: "URL object",
      create: () => new URL("https://example.test/terrain.bin"),
    },
    { name: "Blob", create: () => new Blob([new Uint8Array(32)]) },
    {
      name: "File",
      create: () => new File([new Uint8Array(32)], "terrain.bin"),
    },
    { name: "ArrayBuffer", create: () => new ArrayBuffer(32) },
  ];

  it.each(replayableSources)(
    "replays the latest successful $name descriptor once without progress reuse",
    async ({ create }) => {
      const first = new FakeRuntime();
      const replacement = new FakeRuntime();
      const runtimes = [first, replacement];
      let creates = 0;
      setViewerRuntimeFactoryForTests({
        create: async () => runtimes[creates++] as FakeRuntime,
      });
      const viewer = await Forge3DViewer.create({} as HTMLCanvasElement, {
        controls: false,
        resize: false,
      });
      const source = create();
      const callerController = new AbortController();
      const progressEvents: Array<{
        loaded: number;
        total?: number;
        done: boolean;
      }> = [];
      try {
        await viewer.setTerrainFromSource({
          width: 1,
          height: 4,
          source: new ArrayBuffer(16),
        });
        await viewer.setTerrainFromSource({
          width: 2,
          height: 2,
          source,
          byteOffset: 8,
          byteLength: 16,
          signal: callerController.signal,
          onProgress: (event) => progressEvents.push(event),
        });
        expect(progressEvents).toEqual([
          { loaded: 16, total: 16, done: true },
        ]);
        const initialLatest = first.sources[1];
        expect(initialLatest?.source).toBe(source);
        expect(initialLatest?.signal?.aborted).toBe(false);
        callerController.abort();

        first.lose();
        await vi.waitFor(() => expect(viewer.status).toBe("ready"));
        expect(creates).toBe(2);
        expect(replacement.sources).toHaveLength(1);
        expect(replacement.sources[0]).toMatchObject({
          width: 2,
          height: 2,
          byteOffset: 8,
          byteLength: 16,
        });
        expect(replacement.sources[0]?.source).toBe(source);
        expect(replacement.sources[0]?.onProgress).toBeUndefined();
        expect(replacement.sources[0]?.signal).not.toBe(callerController.signal);
        expect(replacement.sources[0]?.signal?.aborted).toBe(false);
        expect(progressEvents).toEqual([
          { loaded: 16, total: 16, done: true },
        ]);
      } finally {
        viewer.dispose();
      }
    },
  );

  it("ignores duplicate loss from the generation already being recovered", async () => {
    const first = new FakeRuntime();
    const replacement = new FakeRuntime();
    let releaseReplacement!: () => void;
    const replacementReady = new Promise<void>((resolve) => {
      releaseReplacement = resolve;
    });
    let creates = 0;
    const errors: string[] = [];
    setViewerRuntimeFactoryForTests({
      create: async () => {
        creates += 1;
        if (creates === 1) {
          return first;
        }
        await replacementReady;
        return replacement;
      },
    });
    const viewer = await Forge3DViewer.create({} as HTMLCanvasElement, {
      controls: false,
      resize: false,
      onError: (error) => errors.push(error.code),
    });
    const staleLossHandler = first.lossHandler;

    first.lose();
    expect(viewer.status).toBe("recovering");
    staleLossHandler?.(new Forge3DError("DEVICE_LOST", "duplicate stale loss"));
    releaseReplacement();

    await vi.waitFor(() => expect(viewer.status).toBe("ready"));
    expect(creates).toBe(2);
    expect(viewer.getDiagnostics()).toMatchObject({
      generation: 2,
      recoveryAttempts: 1,
      activeRuntimes: 1,
    });
    expect(errors).toEqual(["DEVICE_LOST"]);
  });

  it("serializes source loads and cancels an active load during recovery", async () => {
    let releaseSource!: () => void;
    const pendingSource = new Promise<void>((resolve) => {
      releaseSource = resolve;
    });
    const first = new FakeRuntime(pendingSource);
    const second = new FakeRuntime();
    const runtimes = [first, second];
    let index = 0;
    setViewerRuntimeFactoryForTests({
      create: async () => runtimes[index++] as FakeRuntime,
    });
    const viewer = await Forge3DViewer.create({} as HTMLCanvasElement, {
      controls: false,
      resize: false,
    });
    const source = {
      width: 2,
      height: 2,
      source: new ArrayBuffer(16),
    };
    const load = viewer.setTerrainFromSource(source);
    await expect(viewer.setTerrainFromSource(source)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    first.lose();
    expect(viewer.status).toBe("recovering");
    releaseSource();
    await expect(load).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    await vi.waitFor(() => expect(viewer.status).toBe("ready"));
    expect(second.sourceCalls).toBe(0);
  });

  it("invalidates an in-flight replacement when disposed", async () => {
    const first = new FakeRuntime();
    const replacement = new FakeRuntime();
    let releaseReplacement!: () => void;
    const replacementReady = new Promise<void>((resolve) => {
      releaseReplacement = resolve;
    });
    let creates = 0;
    setViewerRuntimeFactoryForTests({
      create: async () => {
        creates += 1;
        if (creates === 1) {
          return first;
        }
        await replacementReady;
        return replacement;
      },
    });
    const viewer = await Forge3DViewer.create({} as HTMLCanvasElement, {
      controls: false,
      resize: false,
    });
    first.lose();
    expect(viewer.status).toBe("recovering");
    viewer.dispose();
    releaseReplacement();
    await vi.waitFor(() => expect(replacement.disposed).toBe(true));
    expect(first.disposeCalls).toBe(1);
    expect(replacement.disposeCalls).toBe(1);
    expect(viewer.status).toBe("disposed");
    expect(viewer.getDiagnostics().activeRuntimes).toBe(0);
  });

  it("queues replacement-generation loss and aborts recovery replay", async () => {
    let releaseReplay!: () => void;
    const pendingReplay = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });
    const first = new FakeRuntime();
    const replacement = new FakeRuntime(pendingReplay);
    const runtimes = [first, replacement];
    let index = 0;
    setViewerRuntimeFactoryForTests({
      create: async () => runtimes[index++] as FakeRuntime,
    });
    const errors: string[] = [];
    const viewer = await Forge3DViewer.create({} as HTMLCanvasElement, {
      controls: false,
      resize: false,
      onError: (error) => errors.push(error.code),
    });
    await viewer.setTerrainFromSource({
      width: 2,
      height: 2,
      source: new ArrayBuffer(16),
    });
    first.lose();
    await vi.waitFor(() => expect(replacement.sourceCalls).toBe(1));
    replacement.lose();
    await vi.waitFor(() => expect(viewer.status).toBe("failed"));
    expect(replacement.sourceAbortCount).toBe(1);
    expect(viewer.getDiagnostics().activeRuntimes).toBe(0);
    expect(errors).toEqual(["DEVICE_LOST", "DEVICE_LOST"]);
    releaseReplay();
  });

  it("disposal aborts source replay owned by recovery", async () => {
    let releaseReplay!: () => void;
    const pendingReplay = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });
    const first = new FakeRuntime();
    const replacement = new FakeRuntime(pendingReplay);
    const runtimes = [first, replacement];
    let index = 0;
    setViewerRuntimeFactoryForTests({
      create: async () => runtimes[index++] as FakeRuntime,
    });
    const viewer = await Forge3DViewer.create({} as HTMLCanvasElement, {
      controls: false,
      resize: false,
    });
    await viewer.setTerrainFromSource({
      width: 2,
      height: 2,
      source: new Blob([new Uint8Array(16)]),
    });
    first.lose();
    await vi.waitFor(() => expect(replacement.sourceCalls).toBe(1));
    viewer.dispose();
    await vi.waitFor(() => expect(replacement.sourceAbortCount).toBe(1));
    expect(viewer.status).toBe("disposed");
    expect(viewer.getDiagnostics().activeRuntimes).toBe(0);
    releaseReplay();
  });

  it("does not consume device recovery for an unrecoverable surface error", async () => {
    const runtime = new FakeRuntime();
    runtime.renderError = new Forge3DError("SURFACE_LOST", "test surface");
    let creates = 0;
    setViewerRuntimeFactoryForTests({
      create: async () => {
        creates += 1;
        return runtime;
      },
    });
    const viewer = await Forge3DViewer.create({} as HTMLCanvasElement, {
      controls: false,
      resize: false,
    });
    rafCallbacks.shift()?.(0);
    expect(viewer.status).toBe("failed");
    expect(creates).toBe(1);
    expect(viewer.getDiagnostics().recoveryAttempts).toBe(0);
  });

  it("reports constructor-time validation failure through frozen callbacks", async () => {
    const changes: string[] = [];
    const errors: string[] = [];
    await expect(
      Forge3DViewer.create({} as HTMLCanvasElement, {
        controls: false,
        resize: false,
        resources: { budget: { maxCanvasPixels: 0 } },
        onStatusChange: ({ previous, current }) =>
          changes.push(`${previous}->${current}`),
        onError: (error) => errors.push(error.code),
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(changes).toEqual(["initializing->failed"]);
    expect(errors).toEqual(["INVALID_INPUT"]);
  });

  for (const reporterMode of ["reportError", "setTimeout"] as const) {
    describe(`throwing callbacks with ${reporterMode}`, () => {
      it("preserves lifecycle transitions, terminal state, and cleanup", async () => {
        const deferred = interceptCallbackErrors(reporterMode);
        const runtime = new FakeRuntime();
        const transitions: string[] = [];
        const errors: Forge3DError[] = [];
        const readyCallbackError = new Error("ready status callback");
        const failedCallbackError = new Error("failed status callback");
        const disposedCallbackError = new Error("disposed status callback");
        const errorCallbackError = new Error("error callback");
        const statusCallbackErrors = [
          readyCallbackError,
          failedCallbackError,
          disposedCallbackError,
        ];
        let statusCallbackIndex = 0;

        const viewer = await createViewer(runtime, {
          recovery: { deviceLoss: "none" },
          onStatusChange: ({ previous, current }) => {
            transitions.push(`${previous}->${current}`);
            throw statusCallbackErrors[statusCallbackIndex++];
          },
          onError: (error) => {
            errors.push(error);
            throw errorCallbackError;
          },
        });

        expect(deferred.reported).toEqual([]);
        viewer.render();
        rafCallbacks.shift()?.(0);
        expect(runtime.renderCalls).toBe(1);

        runtime.lose();
        expect(viewer.status).toBe("failed");
        expect(viewer.disposed).toBe(false);
        expect(errors).toHaveLength(1);
        expect(captureThrown(() => viewer.render())).toBe(errors[0]);
        expect(runtime.disposed).toBe(true);
        expect(runtime.lossHandler).toBeUndefined();

        viewer.dispose();
        expect(viewer.status).toBe("disposed");
        expect(viewer.disposed).toBe(true);
        expect(viewer.getDiagnostics()).toMatchObject({
          activePointers: 0,
          ownedListeners: 0,
          activeObservers: 0,
          activeRuntimes: 0,
          pendingAnimationFrame: false,
        });
        const deferredCount = deferred.pendingCount();
        viewer.dispose();
        expect(deferred.pendingCount()).toBe(deferredCount);
        expect(transitions).toEqual([
          "initializing->ready",
          "ready->failed",
          "failed->disposed",
        ]);
        deferred.assertAndDrain([
          readyCallbackError,
          errorCallbackError,
          failedCallbackError,
          disposedCallbackError,
        ]);
      });

      it("preserves the original initialization failure and cleans the runtime", async () => {
        const deferred = interceptCallbackErrors(reporterMode);
        const runtime = new FakeRuntime();
        const initializationError = new Forge3DError(
          "INVALID_INPUT",
          "camera initialization failed",
        );
        runtime.cameraError = initializationError;
        let factoryCalls = 0;
        setViewerRuntimeFactoryForTests({
          create: async () => {
            factoryCalls += 1;
            return runtime;
          },
        });
        const notifications: string[] = [];
        const statusCallbackError = new Error("initialization status callback");
        const errorCallbackError = new Error("initialization error callback");

        const rejection = await captureRejection(
          Forge3DViewer.create({} as HTMLCanvasElement, {
            controls: false,
            resize: false,
            onStatusChange: ({ previous, current }) => {
              notifications.push(`status:${previous}->${current}`);
              throw statusCallbackError;
            },
            onError: (error) => {
              notifications.push(`error:${error.code}`);
              throw errorCallbackError;
            },
          }),
        );

        expect(rejection).toBe(initializationError);
        expect(factoryCalls).toBe(1);
        expect(notifications).toEqual([
          "status:initializing->failed",
          "error:INVALID_INPUT",
        ]);
        expect(runtime.disposed).toBe(true);
        expect(runtime.lossHandler).toBeUndefined();
        deferred.assertAndDrain([statusCallbackError, errorCallbackError]);
      });

      it("reports validation failure before creating a runtime", async () => {
        const deferred = interceptCallbackErrors(reporterMode);
        let factoryCalls = 0;
        setViewerRuntimeFactoryForTests({
          create: async () => {
            factoryCalls += 1;
            return new FakeRuntime();
          },
        });
        const notifications: string[] = [];
        const callbackErrors: Forge3DError[] = [];
        const statusCallbackError = new Error("validation status callback");
        const errorCallbackError = new Error("validation error callback");

        const rejection = await captureRejection(
          Forge3DViewer.create({} as HTMLCanvasElement, {
            controls: false,
            resize: false,
            resources: { budget: { maxCanvasPixels: 0 } },
            onStatusChange: ({ previous, current }) => {
              notifications.push(`status:${previous}->${current}`);
              throw statusCallbackError;
            },
            onError: (error) => {
              callbackErrors.push(error);
              notifications.push(`error:${error.code}`);
              throw errorCallbackError;
            },
          }),
        );

        expect(factoryCalls).toBe(0);
        expect(callbackErrors).toHaveLength(1);
        expect(rejection).toBe(callbackErrors[0]);
        expect(notifications).toEqual([
          "status:initializing->failed",
          "error:INVALID_INPUT",
        ]);
        deferred.assertAndDrain([statusCallbackError, errorCallbackError]);
      });
    });
  }
});

function interceptCallbackErrors(mode: "reportError" | "setTimeout"): {
  readonly reported: unknown[];
  pendingCount(): number;
  assertAndDrain(expected: unknown[]): void;
} {
  const reported: unknown[] = [];
  const microtasks: Array<() => void> = [];
  const timers: Array<{ callback: () => void; delay: number | undefined }> = [];
  vi.stubGlobal("queueMicrotask", (callback: () => void) => {
    microtasks.push(callback);
  });
  vi.stubGlobal(
    "setTimeout",
    (callback: () => void, delay?: number): number => {
      timers.push({ callback, delay });
      return timers.length;
    },
  );
  vi.stubGlobal(
    "reportError",
    mode === "reportError"
      ? (error: unknown) => {
          reported.push(error);
        }
      : undefined,
  );

  return {
    reported,
    pendingCount: () => microtasks.length + timers.length,
    assertAndDrain(expected) {
      expect(reported).toEqual([]);
      if (mode === "reportError") {
        expect(timers).toEqual([]);
        expect(microtasks).toHaveLength(expected.length);
        for (const callback of microtasks) {
          expect(callback()).toBeUndefined();
        }
        expect(reported).toHaveLength(expected.length);
        reported.forEach((error, index) => {
          expect(error).toBe(expected[index]);
        });
        return;
      }
      expect(microtasks).toEqual([]);
      expect(timers.map(({ delay }) => delay)).toEqual(
        expected.map(() => 0),
      );
      expect(timers).toHaveLength(expected.length);
      timers.forEach(({ callback }, index) => {
        expect(captureThrown(callback)).toBe(expected[index]);
      });
      expect(reported).toEqual([]);
    },
  };
}

function captureThrown(callback: () => void): unknown {
  try {
    callback();
  } catch (error) {
    return error;
  }
  throw new Error("Expected callback to throw");
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise to reject");
}

async function createViewer(
  runtime: FakeRuntime,
  options: Parameters<typeof Forge3DViewer.create>[1] = {},
): Promise<Forge3DViewer> {
  setViewerRuntimeFactoryForTests({ create: async () => runtime });
  return Forge3DViewer.create({} as HTMLCanvasElement, {
    controls: false,
    resize: false,
    ...options,
  });
}

class FakeViewerCanvas extends EventTarget {
  readonly style = { touchAction: "" };
  readonly captures = new Set<number>();
  readonly #attributes = new Map<string, string>();
  cssWidth = 400;
  cssHeight = 300;

  setAttribute(name: string, value: string): void {
    this.#attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.#attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.#attributes.delete(name);
  }

  setPointerCapture(pointerId: number): void {
    this.captures.add(pointerId);
  }

  hasPointerCapture(pointerId: number): boolean {
    return this.captures.has(pointerId);
  }

  releasePointerCapture(pointerId: number): void {
    this.captures.delete(pointerId);
  }

  focus(): void {}

  getBoundingClientRect(): DOMRect {
    return {
      x: 0,
      y: 0,
      width: this.cssWidth,
      height: this.cssHeight,
      top: 0,
      right: this.cssWidth,
      bottom: this.cssHeight,
      left: 0,
      toJSON: () => ({}),
    };
  }
}

class FakeViewerAnimationFrames {
  readonly #callbacks = new Map<number, FrameRequestCallback>();
  readonly cancelled: number[] = [];
  #nextHandle = 1;

  readonly request = (callback: FrameRequestCallback): number => {
    const handle = this.#nextHandle;
    this.#nextHandle += 1;
    this.#callbacks.set(handle, callback);
    return handle;
  };

  readonly cancel = (handle: number): void => {
    this.cancelled.push(handle);
    this.#callbacks.delete(handle);
  };

  get pending(): number {
    return this.#callbacks.size;
  }

  get pendingHandles(): number[] {
    return [...this.#callbacks.keys()];
  }

  flush(): void {
    const callbacks = [...this.#callbacks.values()];
    this.#callbacks.clear();
    for (const callback of callbacks) {
      callback(0);
    }
  }
}

interface ViewerEventCounts {
  resizeCalls: number;
  renderCalls: number;
  submittedFrames: number;
}

function viewerEventCounts(
  viewer: Forge3DViewer,
  runtime: FakeRuntime,
): ViewerEventCounts {
  return {
    resizeCalls: runtime.resizeCalls,
    renderCalls: runtime.renderCalls,
    submittedFrames: viewer.getDiagnostics().submittedFrames,
  };
}

function expectNoResizeOrFrame(
  viewer: Forge3DViewer,
  runtime: FakeRuntime,
  frames: FakeViewerAnimationFrames,
  before: ViewerEventCounts,
): void {
  expect(runtime.resizeCalls).toBe(before.resizeCalls);
  expect(runtime.renderCalls).toBe(before.renderCalls);
  expect(viewer.getDiagnostics().submittedFrames).toBe(before.submittedFrames);
  expect(frames.pending).toBe(0);
}

function flushResizeTransition(
  viewer: Forge3DViewer,
  runtime: FakeRuntime,
  frames: FakeViewerAnimationFrames,
  before: ViewerEventCounts,
  expectedSize: readonly [number, number],
): void {
  expect(runtime.resizeCalls).toBe(before.resizeCalls + 1);
  expect([runtime.width, runtime.height]).toEqual(expectedSize);
  expect(runtime.renderCalls).toBe(before.renderCalls);
  expect(viewer.getDiagnostics().submittedFrames).toBe(before.submittedFrames);
  expect(frames.pending).toBe(1);
  frames.flush();
  expect(runtime.renderCalls).toBe(before.renderCalls + 1);
  expect(viewer.getDiagnostics().submittedFrames).toBe(
    before.submittedFrames + 1,
  );
  expect(frames.pending).toBe(0);
}

class ControlledViewerResizeObserver {
  readonly observeCalls: Array<{
    target: Element;
    options?: ResizeObserverOptions;
  }> = [];
  disconnectCalls = 0;

  constructor(
    readonly callback: ResizeObserverCallback,
    readonly rejectDevicePixelBox: boolean,
  ) {}

  observe(target: Element, options?: ResizeObserverOptions): void {
    this.observeCalls.push({ target, options });
    if (this.rejectDevicePixelBox && options !== undefined) {
      throw new TypeError("device-pixel-content-box is unavailable");
    }
  }

  unobserve(): void {}

  disconnect(): void {
    this.disconnectCalls += 1;
  }

  deliver(
    target: EventTarget,
    cssWidth: number,
    cssHeight: number,
    devicePixelWidth?: number,
    devicePixelHeight?: number,
  ): void {
    const entry = {
      target,
      contentRect: { width: cssWidth, height: cssHeight },
      contentBoxSize: [{ inlineSize: cssWidth, blockSize: cssHeight }],
      devicePixelContentBoxSize:
        devicePixelWidth === undefined || devicePixelHeight === undefined
          ? []
          : [{ inlineSize: devicePixelWidth, blockSize: devicePixelHeight }],
      borderBoxSize: [],
    } as unknown as ResizeObserverEntry;
    this.callback([entry], this as unknown as ResizeObserver);
  }
}

function installViewerResizeObserver(rejectDevicePixelBox = false): {
  instances: ControlledViewerResizeObserver[];
} {
  const instances: ControlledViewerResizeObserver[] = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      readonly #delegate: ControlledViewerResizeObserver;

      constructor(callback: ResizeObserverCallback) {
        this.#delegate = new ControlledViewerResizeObserver(
          callback,
          rejectDevicePixelBox,
        );
        instances.push(this.#delegate);
      }

      observe(target: Element, options?: ResizeObserverOptions): void {
        this.#delegate.observe(target, options);
      }

      unobserve(target: Element): void {
        this.#delegate.unobserve(target);
      }

      disconnect(): void {
        this.#delegate.disconnect();
      }
    },
  );
  return { instances };
}

function pageTransitionEvent(type: string, persisted: boolean): Event {
  const event = new Event(type);
  Object.defineProperty(event, "persisted", { value: persisted });
  return event;
}

function pointerEvent(
  type: string,
  pointerId: number,
  clientX: number,
  clientY: number,
): Event {
  const event = new Event(type, { cancelable: true });
  for (const [name, value] of Object.entries({
    pointerId,
    pointerType: "mouse",
    button: 0,
    buttons: 1,
    clientX,
    clientY,
  })) {
    Object.defineProperty(event, name, { configurable: true, value });
  }
  return event;
}
