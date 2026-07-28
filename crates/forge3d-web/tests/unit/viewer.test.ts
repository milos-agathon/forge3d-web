import { beforeEach, describe, expect, it, vi } from "vitest";
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
  width = 64;
  height = 64;
  renderCalls = 0;
  terrainCalls = 0;
  cameraCalls = 0;
  resizeCalls = 0;
  sourceCalls = 0;
  sourceAbortCount = 0;
  renderError: Forge3DError | undefined;
  cameraError: Forge3DError | undefined;
  resizeError: Forge3DError | undefined;
  renderSubmitted = true;
  screenshotError: Forge3DError | undefined;
  lossHandler: ((error: Forge3DError) => void) | undefined;
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
  }

  lose(): void {
    this.lossHandler?.(new Forge3DError("DEVICE_LOST", "test loss"));
  }

  setTerrain(_terrain: TerrainHeightmapInput): void {
    this.terrainCalls += 1;
  }

  async setTerrainFromSource(
    terrain: TerrainHeightmapSourceInput,
  ): Promise<void> {
    this.sourceCalls += 1;
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

  it("recreates once, replays committed state, and fails on a second loss", async () => {
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
    viewer.setTerrain({
      width: 2,
      height: 2,
      heights: new Float32Array([0, 1, 1, 0]),
    });

    runtimes[0]?.lose();
    await vi.waitFor(() => expect(viewer.status).toBe("ready"));
    expect(index).toBe(2);
    expect(runtimes[1]?.terrainCalls).toBe(1);
    expect(viewer.getDiagnostics().recoveryAttempts).toBe(1);

    runtimes[1]?.lose();
    expect(viewer.status).toBe("failed");
    expect(errors).toEqual(["DEVICE_LOST", "DEVICE_LOST"]);
    expect(viewer.getDiagnostics().activeRuntimes).toBe(0);
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
});

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
