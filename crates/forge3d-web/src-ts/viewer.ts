import {
  Forge3DError,
  Forge3DRuntime,
  type Forge3DRuntimeCapabilities,
  type Forge3DRuntimeOptions,
  type Forge3DViewerOptions,
  type HeightAoOptions,
  type OrbitView,
  type ResizeInput,
  type SunVisibilityOptions,
  type TerrainColorRampInput,
  type TerrainColormapInput,
  type TerrainDebugView,
  type TerrainHeightmapInput,
  type TerrainHeightmapSourceInput,
  type ViewerCapabilities,
  type ViewerDiagnostics,
  type ViewerResourceBudget,
  type ViewerStatus,
} from "./index.js";
import { OrbitController } from "./orbit-controller.js";
import { RenderScheduler } from "./render-scheduler.js";
import { ResizeController, computeBackingSize } from "./resize-controller.js";
import { OwnedDomResources, ViewerControls } from "./viewer-controls.js";
import {
  resolveResourceBudget,
  validateExplicitResize,
  validateScreenshotBudget,
  validateSourceAgainstBudget,
  validateTerrainAgainstBudget,
} from "./resource-policy.js";
import {
  setRuntimeDeviceLostHandler,
  simulateRuntimeDeviceLossForTests,
} from "./runtime-internals.js";

interface ViewerRuntime {
  readonly disposed: boolean;
  readonly width: number;
  readonly height: number;
  getCapabilities(): Forge3DRuntimeCapabilities;
  setDeviceLostHandler?(
    handler: ((error: Forge3DError) => void) | undefined,
  ): void;
  simulateDeviceLossForTesting?(): void;
  setTerrain(terrain: TerrainHeightmapInput): void;
  setTerrainFromSource(terrain: TerrainHeightmapSourceInput): Promise<void>;
  setCamera(camera: ReturnType<OrbitController["getCamera"]>): void;
  resize(size: ResizeInput): void;
  render(): boolean;
  screenshot(): Promise<Blob>;
  dispose(): void;
}

interface ViewerRuntimeFactory {
  create(
    canvas: HTMLCanvasElement,
    options: Forge3DRuntimeOptions,
  ): Promise<ViewerRuntime>;
}

let runtimeFactoryOverride: ViewerRuntimeFactory | undefined;

interface DirectTerrainReplay {
  kind: "direct";
  value: TerrainHeightmapInput;
}

interface SourceTerrainReplay {
  kind: "source";
  value: TerrainHeightmapSourceInput;
}

type TerrainReplay = DirectTerrainReplay | SourceTerrainReplay;

const DEFAULT_VIEW: Readonly<OrbitView> = Object.freeze({
  target: [0, 0, 0] as [number, number, number],
  distance: 2.72,
  yawDegrees: 0,
  pitchDegrees: 24,
  fovYDegrees: 46,
  near: 0.01,
  far: 100,
});

const VIEWER_TEST_DEVICE_LOSS = Symbol("forge3d-viewer-test-device-loss");

export class Forge3DViewer {
  readonly #canvas: HTMLCanvasElement;
  readonly #options: Forge3DViewerOptions;
  readonly #runtimeOptions: Forge3DRuntimeOptions;
  readonly #runtimeFactory: ViewerRuntimeFactory;
  readonly #controller: OrbitController;
  readonly #budget: ViewerResourceBudget;
  readonly #maxDevicePixelRatio: number;
  readonly #recoveryMode: "none" | "once";
  readonly #resources = new OwnedDomResources();

  #runtime: ViewerRuntime | undefined;
  #controls: ViewerControls | undefined;
  #scheduler: RenderScheduler | undefined;
  #resizeController: ResizeController | undefined;
  #status: ViewerStatus = "initializing";
  #terminalError: Forge3DError | undefined;
  #capabilities: Forge3DRuntimeCapabilities;
  #lastSize: ResizeInput | undefined;
  #terrainReplay: TerrainReplay | undefined;
  #sourceController: AbortController | undefined;
  #sourcePromise: Promise<void> | undefined;
  #screenshotPromise: Promise<Blob> | undefined;
  #generation = 0;
  #activeRuntimes = 0;
  #recoveryAttempts = 0;
  #recoveryPromise: Promise<void> | undefined;
  #recoveryController: AbortController | undefined;
  #recoveringFromGeneration: number | undefined;
  #queuedDeviceLoss:
    | { generation: number; error: Forge3DError }
    | undefined;
  #initializationComplete = false;

  private constructor(
    canvas: HTMLCanvasElement,
    options: Forge3DViewerOptions,
    runtimeFactory: ViewerRuntimeFactory,
  ) {
    this.#canvas = canvas;
    this.#options = options;
    this.#runtimeFactory = runtimeFactory;
    this.#budget = resolveResourceBudget(options.resources);
    this.#maxDevicePixelRatio = normalizeMaxDevicePixelRatio(
      options.resize === false
        ? undefined
        : options.resize?.maxDevicePixelRatio,
    );
    this.#recoveryMode = options.recovery?.deviceLoss ?? "once";
    this.#runtimeOptions = viewerRuntimeOptions(options.runtime);
    this.#controller = new OrbitController(
      options.initialView ?? cloneView(DEFAULT_VIEW),
      options.controls === false ? undefined : options.controls,
    );
    this.#capabilities = {
      deviceState: "disposed",
      maxTextureDimension2D: 0,
      maxBufferSize: 0,
      surfaceFormat: "",
    };
  }

  static async create(
    canvas: HTMLCanvasElement,
    options: Forge3DViewerOptions = {},
  ): Promise<Forge3DViewer> {
    return Forge3DViewer.#create(
      canvas,
      options,
      runtimeFactoryOverride ?? Forge3DRuntime,
    );
  }

  static async #create(
    canvas: HTMLCanvasElement,
    options: Forge3DViewerOptions,
    runtimeFactory: ViewerRuntimeFactory,
  ): Promise<Forge3DViewer> {
    let viewer: Forge3DViewer | undefined;
    try {
      viewer = new Forge3DViewer(canvas, options, runtimeFactory);
      await viewer.#initialize();
      if (viewer.#status === "failed" || viewer.#status === "disposed") {
        throw (
          viewer.#terminalError ??
          new Forge3DError(
            viewer.#status === "disposed"
              ? "RUNTIME_DISPOSED"
              : "INTERNAL_ERROR",
            `Viewer initialization ended in ${viewer.#status}`,
          )
        );
      }
      if (viewer.#recoveryPromise !== undefined) {
        await viewer.#recoveryPromise;
        viewer.#ownedRuntimeOrThrow();
      }
      if (viewer.#status === "initializing" || viewer.#status === "recovering") {
        viewer.#transition("ready");
      }
      viewer.#scheduler?.requestRender();
      return viewer;
    } catch (error) {
      const normalized = Forge3DError.from(error);
      if (viewer === undefined) {
        safeExternalCallback(() =>
          options.onStatusChange?.({
            previous: "initializing",
            current: "failed",
          }),
        );
        safeExternalCallback(() => options.onError?.(normalized));
      } else if (viewer.#status !== "failed" && viewer.#status !== "disposed") {
        viewer.#terminalError = normalized;
        viewer.#transition("failed");
        viewer.#emitError(normalized);
        viewer.#disposeOwnedResources(false);
      }
      throw normalized;
    }
  }

  get disposed(): boolean {
    return this.#status === "disposed";
  }

  get status(): ViewerStatus {
    return this.#status;
  }

  getView(): OrbitView {
    return this.#controller.getView();
  }

  getCapabilities(): ViewerCapabilities {
    return {
      ...this.#capabilities,
      secureContext: true,
      webgpuAvailable: true,
    };
  }

  getDiagnostics(): ViewerDiagnostics {
    const scheduler = this.#scheduler;
    return {
      generation: this.#generation,
      renderRequests: scheduler?.renderRequests ?? 0,
      submittedFrames: scheduler?.submittedFrames ?? 0,
      skippedFrames: scheduler?.skippedFrames ?? 0,
      activePointers: this.#resources.activePointers,
      ownedListeners: this.#resources.ownedListeners,
      activeObservers: this.#resources.activeObservers,
      activeRuntimes: this.#activeRuntimes,
      pendingAnimationFrame: scheduler?.pendingAnimationFrame ?? false,
      ownedAnimationFrameCount: scheduler?.ownedAnimationFrameCount ?? 0,
      recoveryAttempts: this.#recoveryAttempts,
      screenshotInFlight: this.#screenshotPromise !== undefined,
      effectiveResourceBudget: { ...this.#budget },
      effectiveMaxDevicePixelRatio: this.#maxDevicePixelRatio,
    };
  }

  setTerrain(terrain: TerrainHeightmapInput): void {
    const runtime = this.#operationalRuntime();
    validateTerrainAgainstBudget(
      terrain,
      this.#budget,
      this.#capabilities.maxTextureDimension2D,
    );
    const replay = cloneTerrain(terrain);
    this.#callRuntime(() => runtime.setTerrain(replay));
    this.#terrainReplay = { kind: "direct", value: replay };
    this.#scheduler?.requestRender();
  }

  async setTerrainFromSource(
    terrain: TerrainHeightmapSourceInput,
  ): Promise<void> {
    const runtime = this.#operationalRuntime();
    if (this.#sourcePromise !== undefined) {
      throw new Forge3DError(
        "INVALID_INPUT",
        "Only one viewer-owned terrain source load may be active",
      );
    }
    validateSourceAgainstBudget(
      terrain,
      this.#budget,
      this.#capabilities.maxTextureDimension2D,
    );
    const controller = new AbortController();
    this.#sourceController = controller;
    const removeAbortForwarder = forwardAbort(terrain.signal, controller);
    const request = cloneSourceRequest(terrain, controller.signal, true);
    const replay = cloneSourceRequest(terrain, undefined, false);
    const promise = runtime.setTerrainFromSource(request);
    this.#sourcePromise = promise;
    try {
      await promise;
      if (controller.signal.aborted) {
        throw new Forge3DError(
          "REQUEST_CANCELLED",
          "Terrain source request was cancelled",
        );
      }
      this.#terrainReplay = { kind: "source", value: replay };
      this.#scheduler?.requestRender();
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Forge3DError(
          "REQUEST_CANCELLED",
          "Terrain source request was cancelled",
          error,
        );
      }
      const normalized = Forge3DError.from(error);
      this.#routeDeviceLoss(normalized);
      throw normalized;
    } finally {
      removeAbortForwarder();
      if (this.#sourcePromise === promise) {
        this.#sourcePromise = undefined;
        this.#sourceController = undefined;
      }
    }
  }

  setView(view: OrbitView): void {
    const runtime = this.#operationalRuntime();
    this.#controller.setView(view);
    this.#callRuntime(() => runtime.setCamera(this.#controller.getCamera()));
    this.#scheduler?.requestRender();
  }

  resetView(): void {
    const runtime = this.#operationalRuntime();
    this.#controller.reset();
    this.#callRuntime(() => runtime.setCamera(this.#controller.getCamera()));
    this.#scheduler?.requestRender();
  }

  resize(size: ResizeInput): void {
    const runtime = this.#operationalRuntime();
    validateExplicitResize(size);
    const backing = computeBackingSize({
      cssWidth: size.width,
      cssHeight: size.height,
      devicePixelRatio: size.devicePixelRatio,
      maxDevicePixelRatio: this.#maxDevicePixelRatio,
      maxCanvasPixels: this.#budget.maxCanvasPixels,
      maxTextureDimension2D: this.#capabilities.maxTextureDimension2D,
    });
    if (backing === null) {
      throw new Forge3DError("INVALID_INPUT", "Resize dimensions must be positive");
    }
    const committed = {
      width: backing.width,
      height: backing.height,
      devicePixelRatio: 1,
    };
    this.#callRuntime(() => runtime.resize(committed));
    this.#lastSize = committed;
    this.#scheduler?.requestRender();
  }

  render(): void {
    this.#operationalRuntime();
    this.#scheduler?.requestRender();
  }

  screenshot(): Promise<Blob> {
    const runtime = this.#operationalRuntime();
    if (this.#screenshotPromise !== undefined) {
      return this.#screenshotPromise;
    }
    validateScreenshotBudget(runtime.width, runtime.height, this.#budget);
    this.#callRuntime(() => runtime.setCamera(this.#controller.getCamera()));
    const promise = runtime.screenshot().catch((error: unknown) => {
      const normalized = Forge3DError.from(error);
      this.#routeDeviceLoss(normalized);
      throw normalized;
    });
    this.#screenshotPromise = promise;
    void promise.then(
      () => this.#clearScreenshotPromise(promise),
      () => this.#clearScreenshotPromise(promise),
    );
    return promise;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.#disposeOwnedResources(true);
    this.#transition("disposed");
  }

  /** @internal Invoked only through the direct-module test seam below. */
  [VIEWER_TEST_DEVICE_LOSS](): void {
    const runtime = this.#operationalRuntime();
    if (runtime instanceof Forge3DRuntime) {
      simulateRuntimeDeviceLossForTests(runtime);
      return;
    }
    if (runtime.simulateDeviceLossForTesting === undefined) {
      throw new Forge3DError(
        "UNSUPPORTED_FEATURE",
        "Runtime does not expose diagnostic device-loss simulation",
      );
    }
    runtime.simulateDeviceLossForTesting();
  }

  async #initialize(): Promise<void> {
    let runtime = await this.#createRuntime();
    if (this.#recoveryPromise !== undefined) {
      await this.#recoveryPromise;
    }
    runtime = this.#ownedRuntimeOrThrow();
    const initializedGeneration = this.#generation;
    runtime.setCamera(this.#controller.getCamera());
    if (
      this.#runtime !== runtime ||
      this.#generation !== initializedGeneration ||
      this.#hasTerminalStatus() ||
      this.#recoveryPromise !== undefined
    ) {
      const recovery = this.#recoveryPromise;
      if (recovery !== undefined) {
        await recovery;
      }
      runtime = this.#ownedRuntimeOrThrow();
    }

    this.#scheduler = new RenderScheduler({
      submitFrame: () => {
        const current = this.#runtime;
        if (current === undefined || this.#status !== "ready") {
          return false;
        }
        return current.render();
      },
      canRender: () =>
        this.#status === "ready" &&
        this.#runtime !== undefined &&
        !this.#resizeController?.suspended,
      onError: (error) => this.#handleRuntimeError(Forge3DError.from(error)),
      resources: this.#resources,
    });

    if (this.#options.controls !== false) {
      this.#controls = new ViewerControls(
        this.#canvas,
        this.#controller,
        this.#options.controls ?? {},
        () => {
          if (this.#status !== "ready") {
            return;
          }
          const current = this.#runtime;
          if (current === undefined) {
            return;
          }
          if (
            !this.#callRuntimeFromCallback(() =>
              current.setCamera(this.#controller.getCamera()),
            )
          ) {
            return;
          }
          this.#scheduler?.requestRender();
        },
        this.#resources,
      );
    }

    if (this.#options.resize !== false) {
      this.#resizeController = new ResizeController({
        canvas: this.#canvas,
        onResize: (size) => {
          if (this.#status === "disposed" || this.#status === "failed") {
            return;
          }
          const current = this.#runtime;
          if (
            current === undefined ||
            !this.#callRuntimeFromCallback(() => current.resize(size))
          ) {
            return;
          }
          this.#lastSize = { ...size };
          this.#scheduler?.requestRender();
        },
        onSuspendedChange: (suspended) => {
          if (suspended) {
            this.#scheduler?.suspend();
          } else if (this.#status === "ready") {
            this.#scheduler?.resume();
            this.#scheduler?.requestRender();
          }
        },
        maxDevicePixelRatio: this.#maxDevicePixelRatio,
        maxCanvasPixels: this.#budget.maxCanvasPixels,
        maxTextureDimension2D: this.#capabilities.maxTextureDimension2D,
        resources: this.#resources,
      });
    } else {
      this.#lastSize = {
        width: runtime.width,
        height: runtime.height,
        devicePixelRatio: 1,
      };
    }
    this.#initializationComplete = true;
  }

  async #createRuntime(): Promise<ViewerRuntime> {
    const previousGeneration = this.#generation;
    const generation = previousGeneration + 1;
    const runtime = await this.#runtimeFactory.create(
      this.#canvas,
      this.#runtimeOptions,
    );
    if (this.#status === "disposed" || this.#status === "failed") {
      if (!runtime.disposed) runtime.dispose();
      throw this.#terminalError ?? new Forge3DError(
        this.#status === "disposed" ? "RUNTIME_DISPOSED" : "INTERNAL_ERROR",
        `Viewer was ${this.#status} during runtime creation`,
      );
    }
    if (this.#generation !== previousGeneration || this.#runtime !== undefined) {
      if (!runtime.disposed) runtime.dispose();
      return this.#ownedRuntimeOrThrow();
    }
    this.#runtime = runtime;
    this.#generation = generation;
    this.#activeRuntimes += 1;
    this.#capabilities = runtime.getCapabilities();
    setViewerRuntimeDeviceLostHandler(runtime, (error) => {
      this.#onDeviceLost(generation, Forge3DError.from(error));
    });
    if (
      this.#runtime !== runtime ||
      this.#generation !== generation ||
      this.#hasTerminalStatus()
    ) {
      if (this.#runtime !== runtime && !runtime.disposed) runtime.dispose();
      const recovery = this.#recoveryPromise;
      if (recovery !== undefined) {
        await recovery;
        return this.#ownedRuntimeOrThrow();
      }
      return this.#ownedRuntimeOrThrow();
    }
    return runtime;
  }

  #ownedRuntimeOrThrow(): ViewerRuntime {
    if (this.#status === "disposed") {
      throw new Forge3DError("RUNTIME_DISPOSED", "Viewer is disposed");
    }
    if (this.#status === "failed") {
      throw this.#terminalError ?? new Forge3DError(
        "INTERNAL_ERROR",
        "Viewer is in a failed state",
      );
    }
    const runtime = this.#runtime;
    if (runtime === undefined || runtime.disposed) {
      throw this.#terminalError ?? new Forge3DError(
        "DEVICE_LOST",
        "Viewer runtime ownership was lost during initialization",
      );
    }
    return runtime;
  }

  #hasTerminalStatus(): boolean {
    return this.#status === "disposed" || this.#status === "failed";
  }

  #onDeviceLost(generation: number, error: Forge3DError): void {
    if (
      generation !== this.#generation ||
      this.#status === "disposed" ||
      this.#status === "failed"
    ) {
      return;
    }
    const normalized =
      error.code === "DEVICE_LOST"
        ? error
        : new Forge3DError("DEVICE_LOST", error.message, error.details);
    if (this.#recoveryPromise !== undefined) {
      if (generation === this.#recoveringFromGeneration) {
        return;
      }
      this.#queuedDeviceLoss = { generation, error: normalized };
      this.#recoveryController?.abort(normalized);
      return;
    }
    this.#emitError(normalized);
    if (this.#recoveryMode === "none" || this.#recoveryAttempts >= 1) {
      this.#fail(normalized);
      return;
    }
    this.#terminalError = normalized;
    this.#transition("recovering");
    this.#scheduler?.suspend();
    this.#controls?.suspend();
    this.#sourceController?.abort();
    this.#recoveringFromGeneration = generation;
    const recovery = this.#recover(generation, normalized);
    this.#recoveryPromise = recovery;
    void recovery.then(
      () => this.#finishRecovery(recovery),
      () => this.#finishRecovery(recovery),
    );
  }

  async #recover(
    lostGeneration: number,
    loss: Forge3DError,
  ): Promise<void> {
    this.#recoveryAttempts += 1;
    const recoveryController = new AbortController();
    this.#recoveryController = recoveryController;
    const failedRuntime = this.#runtime;
    if (failedRuntime !== undefined) {
      setViewerRuntimeDeviceLostHandler(failedRuntime, undefined);
      failedRuntime.dispose();
      this.#runtime = undefined;
      this.#activeRuntimes -= 1;
      this.#capabilities = {
        ...this.#capabilities,
        deviceState: "lost",
      };
    }
    try {
      const replacement = await this.#createRuntime();
      if (
        this.#status === "disposed" ||
        this.#status === "failed" ||
        lostGeneration + 1 !== this.#generation ||
        this.#runtime !== replacement ||
        recoveryController.signal.aborted
      ) {
        if (this.#runtime !== replacement && !replacement.disposed) {
          replacement.dispose();
        }
        if (this.#runtime === replacement) {
          setViewerRuntimeDeviceLostHandler(replacement, undefined);
          if (!replacement.disposed) replacement.dispose();
          this.#runtime = undefined;
          this.#activeRuntimes -= 1;
        }
        return;
      }
      replacement.setCamera(this.#controller.getCamera());
      if (this.#runtime !== replacement || recoveryController.signal.aborted) {
        return;
      }
      if (this.#lastSize !== undefined) {
        replacement.resize(this.#lastSize);
      }
      if (this.#runtime !== replacement || recoveryController.signal.aborted) {
        return;
      }
      if (this.#terrainReplay?.kind === "direct") {
        replacement.setTerrain(this.#terrainReplay.value);
      } else if (this.#terrainReplay?.kind === "source") {
        await replacement.setTerrainFromSource(
          cloneSourceRequest(
            this.#terrainReplay.value,
            recoveryController.signal,
            false,
          ),
        );
      }
      if (
        this.#hasTerminalStatus() ||
        this.#runtime !== replacement ||
        recoveryController.signal.aborted
      ) {
        return;
      }
      this.#terminalError = undefined;
      if (this.#initializationComplete) {
        this.#transition("ready");
        this.#controls?.resume();
        this.#scheduler?.resume();
        this.#scheduler?.requestRender();
      }
    } catch (error) {
      if (
        recoveryController.signal.aborted &&
        (this.#status === "disposed" || this.#queuedDeviceLoss !== undefined)
      ) {
        return;
      }
      if (this.#status !== "disposed") {
        const normalized = Forge3DError.from(error);
        const terminal =
          normalized.code === "DEVICE_LOST"
            ? normalized
            : new Forge3DError(
                "DEVICE_LOST",
                "Device recovery failed",
                { loss, cause: normalized },
              );
        this.#emitError(terminal);
        this.#fail(terminal);
      }
    }
  }

  #handleRuntimeError(error: Forge3DError): void {
    if (error.code === "DEVICE_LOST") {
      this.#onDeviceLost(this.#generation, error);
      return;
    }
    this.#emitError(error);
    this.#fail(error);
  }

  #callRuntime<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      const normalized = Forge3DError.from(error);
      this.#routeDeviceLoss(normalized);
      throw normalized;
    }
  }

  #callRuntimeFromCallback(operation: () => void): boolean {
    try {
      this.#callRuntime(operation);
      return true;
    } catch (error) {
      const normalized = Forge3DError.from(error);
      if (normalized.code !== "DEVICE_LOST") {
        this.#handleRuntimeError(normalized);
      }
      return false;
    }
  }

  #routeDeviceLoss(error: Forge3DError): void {
    if (error.code === "DEVICE_LOST") {
      this.#onDeviceLost(this.#generation, error);
    }
  }

  #clearScreenshotPromise(promise: Promise<Blob>): void {
    if (this.#screenshotPromise === promise) {
      this.#screenshotPromise = undefined;
    }
  }

  #finishRecovery(recovery: Promise<void>): void {
    if (this.#recoveryPromise !== recovery) {
      return;
    }
    this.#recoveryPromise = undefined;
    this.#recoveryController = undefined;
    this.#recoveringFromGeneration = undefined;
    const queued = this.#queuedDeviceLoss;
    this.#queuedDeviceLoss = undefined;
    if (
      queued !== undefined &&
      queued.generation === this.#generation &&
      this.#status !== "disposed" &&
      this.#status !== "failed"
    ) {
      this.#onDeviceLost(queued.generation, queued.error);
    }
  }

  #fail(error: Forge3DError): void {
    if (this.#status === "failed" || this.#status === "disposed") {
      return;
    }
    this.#terminalError = error;
    this.#scheduler?.suspend();
    this.#controls?.suspend();
    const runtime = this.#runtime;
    if (runtime !== undefined) {
      this.#capabilities = {
        ...this.#capabilities,
        deviceState:
          error.code === "DEVICE_LOST"
            ? "lost"
            : this.#capabilities.deviceState,
      };
      setViewerRuntimeDeviceLostHandler(runtime, undefined);
      runtime.dispose();
      this.#runtime = undefined;
      this.#activeRuntimes -= 1;
    }
    this.#transition("failed");
  }

  #operationalRuntime(): ViewerRuntime {
    if (this.#status === "disposed") {
      throw new Forge3DError("RUNTIME_DISPOSED", "Viewer is disposed");
    }
    if (this.#status === "recovering") {
      throw (
        this.#terminalError ??
        new Forge3DError("DEVICE_LOST", "Viewer is recovering its GPU device")
      );
    }
    if (this.#status === "failed") {
      throw (
        this.#terminalError ??
        new Forge3DError("INTERNAL_ERROR", "Viewer is in a failed state")
      );
    }
    if (this.#status !== "ready" || this.#runtime === undefined) {
      throw new Forge3DError("INTERNAL_ERROR", "Viewer is not ready");
    }
    return this.#runtime;
  }

  #disposeOwnedResources(transitionRuntime: boolean): void {
    this.#sourceController?.abort();
    this.#sourceController = undefined;
    this.#recoveryController?.abort();
    this.#recoveryController = undefined;
    this.#queuedDeviceLoss = undefined;
    this.#controls?.dispose();
    this.#resizeController?.dispose();
    this.#scheduler?.dispose();
    this.#resources.dispose();
    const runtime = this.#runtime;
    if (runtime !== undefined) {
      this.#capabilities = runtime.getCapabilities();
      setViewerRuntimeDeviceLostHandler(runtime, undefined);
      runtime.dispose();
      this.#runtime = undefined;
      this.#activeRuntimes -= 1;
      if (transitionRuntime) {
        this.#capabilities = {
          ...this.#capabilities,
          deviceState: "disposed",
        };
      }
    }
  }

  #transition(current: ViewerStatus): void {
    if (current === this.#status) {
      return;
    }
    const previous = this.#status;
    this.#status = current;
    this.#safeCallback(() =>
      this.#options.onStatusChange?.({ previous, current }),
    );
  }

  #emitError(error: Forge3DError): void {
    this.#safeCallback(() => this.#options.onError?.(error));
  }

  #safeCallback(callback: () => void): void {
    try {
      callback();
    } catch (error) {
      reportCallbackError(error);
    }
  }
}

/** @internal Direct-module unit-test seam; not exported from the package entrypoint. */
export function setViewerRuntimeFactoryForTests(
  runtimeFactory: ViewerRuntimeFactory | undefined,
): void {
  runtimeFactoryOverride = runtimeFactory;
}

/** @internal Direct-module browser-test seam; not exported from the package entrypoint. */
export function simulateViewerDeviceLossForTests(
  viewer: Forge3DViewer,
): void {
  viewer[VIEWER_TEST_DEVICE_LOSS]();
}

function setViewerRuntimeDeviceLostHandler(
  runtime: ViewerRuntime,
  handler: ((error: unknown) => void) | undefined,
): void {
  if (runtime instanceof Forge3DRuntime) {
    setRuntimeDeviceLostHandler(runtime, handler);
    return;
  }
  runtime.setDeviceLostHandler?.(
    handler === undefined
      ? undefined
      : (error) => handler(error),
  );
}

function viewerRuntimeOptions(
  options: Forge3DRuntimeOptions | undefined,
): Forge3DRuntimeOptions {
  return {
    ...(options ?? {}),
    powerPreference: options?.powerPreference ?? "none",
  };
}

function normalizeMaxDevicePixelRatio(value: number | undefined): number {
  const result = value ?? 2;
  if (!Number.isFinite(result) || result <= 0) {
    throw new Forge3DError(
      "INVALID_INPUT",
      "maxDevicePixelRatio must be finite and positive",
    );
  }
  return result;
}

function cloneView(view: Readonly<OrbitView>): OrbitView {
  return {
    target: [view.target[0], view.target[1], view.target[2]],
    distance: view.distance,
    yawDegrees: view.yawDegrees,
    pitchDegrees: view.pitchDegrees,
    fovYDegrees: view.fovYDegrees,
    near: view.near,
    far: view.far,
  };
}

interface TerrainMetadataCarrier {
  colorRamp?: TerrainColorRampInput;
  colormap?: TerrainColormapInput;
  spacing?: [number, number];
  exaggeration?: number;
  domain?: [number, number];
  nodata?: number;
  crs?: string;
  heightAo?: HeightAoOptions;
  sunVisibility?: SunVisibilityOptions;
  debugView?: TerrainDebugView;
}

function cloneColorRamp(ramp: TerrainColorRampInput): TerrainColorRampInput {
  return {
    stops: ramp.stops.map((stop) => ({
      position: stop.position,
      color: [stop.color[0], stop.color[1], stop.color[2]],
    })),
  };
}

function cloneSunVisibility(
  options: SunVisibilityOptions,
): SunVisibilityOptions {
  const clone: SunVisibilityOptions = { ...options };
  if (options.direction !== undefined) {
    clone.direction = [
      options.direction[0],
      options.direction[1],
      options.direction[2],
    ];
  }
  return clone;
}

function copyTerrainMetadata(
  source: TerrainMetadataCarrier,
  target: TerrainMetadataCarrier,
): void {
  if (source.colorRamp !== undefined) {
    target.colorRamp = cloneColorRamp(source.colorRamp);
  }
  if (source.colormap !== undefined) {
    target.colormap =
      typeof source.colormap === "string"
        ? source.colormap
        : cloneColorRamp(source.colormap);
  }
  if (source.spacing !== undefined) {
    target.spacing = [source.spacing[0], source.spacing[1]];
  }
  if (source.exaggeration !== undefined) {
    target.exaggeration = source.exaggeration;
  }
  if (source.domain !== undefined) {
    target.domain = [source.domain[0], source.domain[1]];
  }
  if (source.nodata !== undefined) {
    target.nodata = source.nodata;
  }
  if (source.crs !== undefined) {
    target.crs = source.crs;
  }
  if (source.heightAo !== undefined) {
    target.heightAo = { ...source.heightAo };
  }
  if (source.sunVisibility !== undefined) {
    target.sunVisibility = cloneSunVisibility(source.sunVisibility);
  }
  if (source.debugView !== undefined) {
    target.debugView = source.debugView;
  }
}

function cloneTerrain(terrain: TerrainHeightmapInput): TerrainHeightmapInput {
  const clone: TerrainHeightmapInput = {
    width: terrain.width,
    height: terrain.height,
    heights: new Float32Array(terrain.heights),
  };
  copyTerrainMetadata(terrain, clone);
  return clone;
}

function cloneSourceRequest(
  terrain: TerrainHeightmapSourceInput,
  signal: AbortSignal | undefined,
  includeProgress: boolean,
): TerrainHeightmapSourceInput {
  const clone: TerrainHeightmapSourceInput = {
    width: terrain.width,
    height: terrain.height,
    source: terrain.source,
  };
  if (terrain.byteOffset !== undefined) {
    clone.byteOffset = terrain.byteOffset;
  }
  if (terrain.byteLength !== undefined) {
    clone.byteLength = terrain.byteLength;
  }
  copyTerrainMetadata(terrain, clone);
  if (signal !== undefined) {
    clone.signal = signal;
  }
  if (includeProgress && terrain.onProgress !== undefined) {
    clone.onProgress = terrain.onProgress;
  }
  return clone;
}

function forwardAbort(
  source: AbortSignal | undefined,
  target: AbortController,
): () => void {
  if (source === undefined) {
    return () => {};
  }
  if (source.aborted) {
    target.abort(source.reason);
    return () => {};
  }
  const abort = () => target.abort(source.reason);
  source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

function reportCallbackError(error: unknown): void {
  const reporter = (globalThis as { reportError?: (value: unknown) => void })
    .reportError;
  if (typeof reporter === "function") {
    queueMicrotask(() => reporter(error));
    return;
  }
  setTimeout(() => {
    throw error;
  }, 0);
}

function safeExternalCallback(callback: () => void): void {
  try {
    callback();
  } catch (error) {
    reportCallbackError(error);
  }
}
