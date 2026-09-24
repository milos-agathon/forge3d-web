import { Forge3DError, Forge3DRuntime } from "./index.js";
import { cloneCameraInput, validateCameraInput } from "./camera.js";
import { captureOnce, renderOffline as renderOfflineTarget } from "./offline.js";
import type { AovFrame, HdrFrame } from "./frames.js";
import type {
  AdapterInfo,
  CameraInput,
  CaptureOptions,
  CaptureResult,
  DenoiseSettingsInput,
  OfflineAccumulationOptions,
  OfflineBatchResult,
  OfflineMetrics,
  OfflineRenderOptions,
  OfflineResolveOptions,
  OfflineResult,
  Forge3DRuntimeCapabilities,
  Forge3DRuntimeOptions,
  Forge3DSessionCapabilities,
  Forge3DSessionOptions,
  IblSnapshot,
  LightingSnapshot,
  MaterialCollectionSnapshot,
  MemoryReport,
  RendererConfigData,
  RenderStats,
  ResizeInput,
  SceneSnapshot,
  SessionStatus,
  ShadowReport,
  ShadowSnapshot,
  TerrainHeightmapInput,
} from "./index.js";
import { RendererConfig } from "./renderer-config.js";
import {
  clonePayload,
  estimateSceneTriangles,
  Forge3DScene,
  sceneShadowsConfigured,
} from "./scene.js";
import { compileScenePasses } from "./render-graph.js";
import { SceneMemoryTracker } from "./memory-policy.js";
import { normalizeRenderStats } from "./native-reports.js";
import { setRuntimeDeviceLostHandler } from "./runtime-internals.js";
import { validateExplicitResize } from "./resource-policy.js";

export interface SessionRuntimeLike {
  readonly disposed?: boolean;
  getCapabilities(): Forge3DRuntimeCapabilities;
  setTerrain?(terrain: TerrainHeightmapInput): void;
  setLighting?(lighting: LightingSnapshot): void;
  setMaterials?(materials: MaterialCollectionSnapshot): void;
  setIbl?(ibl: IblSnapshot | null): void;
  precomputeIbl?(input: IblSnapshot): Promise<IblSnapshot>;
  setShadows?(shadows: ShadowSnapshot): void;
  getShadowReport?(): ShadowReport;
  setScene?(scene: SceneSnapshot): void;
  setCamera?(camera: CameraInput): void;
  setDeviceLostHandler?(handler: ((error: unknown) => void) | undefined): void;
  resize?(size: ResizeInput): void;
  render(): boolean;
  screenshot?(): Promise<Blob>;
  readRgba?(): Promise<Uint8Array>;
  getRenderStats?(): RenderStats;
  getMemoryReport?(): MemoryReport;
  readonly width?: number;
  readonly height?: number;
  beginOfflineAccumulation?(options?: OfflineAccumulationOptions): void;
  accumulateBatch?(sampleCount: number): Promise<OfflineBatchResult>;
  readAccumulationMetrics?(targetVariance: number, tileSize?: number): Promise<OfflineMetrics>;
  resolveOfflineHdr?(options?: OfflineResolveOptions): Promise<CaptureResult>;
  endOfflineAccumulation?(): boolean;
  denoiseHdrFrame?(frame: HdrFrame, aov?: AovFrame, settings?: DenoiseSettingsInput): Promise<HdrFrame>;
  dispose(): void;
}

export type SessionRuntimeFactory = (
  canvas: HTMLCanvasElement | OffscreenCanvas,
  options: Forge3DRuntimeOptions,
) => Promise<SessionRuntimeLike>;

let sessionRuntimeFactory: SessionRuntimeFactory | undefined;

export function setSessionRuntimeFactoryForTests(
  factory: SessionRuntimeFactory | undefined,
): void {
  sessionRuntimeFactory = factory;
}

const SCENE_ALLOCATION_KEY = "scene";

export class Forge3DSession {
  readonly #canvas: HTMLCanvasElement | OffscreenCanvas;
  readonly #options: Forge3DSessionOptions;
  readonly #config: RendererConfig;
  readonly #tracker: SceneMemoryTracker;
  readonly #recoveryMode: "none" | "once";
  #status: SessionStatus = "initializing";
  #runtime: SessionRuntimeLike | undefined;
  #capabilitiesBase: Forge3DRuntimeCapabilities | undefined;
  #detachLoss: (() => void) | undefined;
  #scene: Forge3DScene | undefined;
  #sceneSource: Forge3DScene | undefined;
  #camera: CameraInput | undefined;
  #appliedRevision = -1;
  #committedSnapshot: SceneSnapshot | undefined;
  #sceneReservation: { requestedBytes: number } | undefined;
  #stats: RenderStats = {
    frameIndex: 0,
    frameTimeMs: 0,
    drawCalls: 0,
    triangles: 0,
    passes: [],
  };
  #frameIndex = 0;
  #terminalError: Forge3DError | undefined;
  #recoveryAttempts = 0;
  #recoveryPromise: Promise<void> | undefined;
  #readyWaiters: Array<{
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];
  #generation = 0;

  private constructor(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    options: Forge3DSessionOptions,
  ) {
    this.#canvas = canvas;
    this.#options = { ...options };
    this.#config = RendererConfig.from(options.renderer);
    this.#tracker = new SceneMemoryTracker(
      this.#config.toJSON().memoryBudgetBytes,
    );
    this.#recoveryMode = options.recovery?.deviceLoss ?? "once";
  }

  static async create(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    options: Forge3DSessionOptions = {},
  ): Promise<Forge3DSession> {
    const session = new Forge3DSession(canvas, options);
    await session.#initialize();
    return session;
  }

  get status(): SessionStatus {
    return this.#status;
  }

  get disposed(): boolean {
    return this.#status === "disposed";
  }

  getConfig(): RendererConfig {
    return this.#config;
  }

  getCapabilities(): Forge3DSessionCapabilities {
    let low = this.#capabilitiesBase;
    if (this.#status === "ready" && this.#runtime !== undefined) {
      try {
        low = this.#runtime.getCapabilities();
      } catch {
        low = this.#capabilitiesBase;
      }
    }
    const base: Forge3DRuntimeCapabilities = low ?? {
      deviceState: "ready",
      maxTextureDimension2D: 0,
      maxBufferSize: 0,
      surfaceFormat: "bgra8unorm-srgb",
    };
    const timestampQuery = base.timestampQuery === true;
    const report = this.#tracker.report();
    return {
      deviceState:
        this.#status === "disposed" ? "disposed" : base.deviceState,
      maxTextureDimension2D: base.maxTextureDimension2D,
      maxBufferSize: base.maxBufferSize,
      surfaceFormat: base.surfaceFormat,
      adapterInfo: normalizeAdapterInfo(base.adapterInfo),
      isFallbackAdapter: base.isFallbackAdapter === true,
      features: sortedUnique(base.features ?? []),
      limits: { ...(base.limits ?? {}) },
      surfaceFormats: sortedUnique(base.surfaceFormats ?? []),
      preferredCanvasFormat: base.preferredCanvasFormat ?? base.surfaceFormat,
      timestampQuery,
      timingMode:
        timestampQuery && this.#config.toJSON().timestampMode !== "disabled"
          ? "gpu-timestamp"
          : "cpu",
      effectiveQuality:
        report.allocationCount > 0
          ? report.effectiveQuality
          : this.#config.toJSON().quality,
      offscreenCanvas: hasOffscreenCanvas(),
      workers: hasWorkers(),
      sharedArrayBuffer: hasSharedArrayBuffer(),
      fileSystemAccess: hasFileSystemAccess(),
      opfs: hasOpfs(),
    };
  }

  getRenderStats(): RenderStats {
    return {
      ...this.#stats,
      passes: this.#stats.passes.map((pass) => ({ ...pass })),
    };
  }

  getMemoryReport(): MemoryReport {
    return this.#tracker.report();
  }

  async precomputeIbl(input: IblSnapshot): Promise<IblSnapshot> {
    const runtime = this.#runtimeOrThrow();
    if (runtime.precomputeIbl === undefined) {
      throw new Forge3DError(
        "UNSUPPORTED_FEATURE",
        "Runtime does not support IBL precomputation",
      );
    }
    return runtime.precomputeIbl(clonePayload(input));
  }

  getShadowReport(): ShadowReport {
    const runtime = this.#runtimeOrThrow();
    const report = runtime.getShadowReport?.();
    if (report !== undefined) {
      return report;
    }
    const sceneReport = this.#scene?.getShadowReport();
    if (sceneReport !== undefined) {
      return sceneReport;
    }
    throw new Forge3DError(
      "UNSUPPORTED_FEATURE",
      "Runtime does not report shadow state",
    );
  }

  setScene(scene: Forge3DScene): void {
    const runtime = this.#runtimeOrThrow();
    if (!(scene instanceof Forge3DScene)) {
      throw new Forge3DError("INVALID_INPUT", "scene must be a Forge3DScene");
    }
    if (scene.disposed) {
      throw new Forge3DError("INVALID_INPUT", "scene is disposed");
    }
    this.#commitScene(runtime, scene);
  }

  getScene(): Forge3DScene | undefined {
    return this.#scene?.copy();
  }

  /** Drawing-buffer width of the live runtime (0 before initialization). */
  get width(): number {
    return this.#runtime?.width ?? 0;
  }

  /** Drawing-buffer height of the live runtime (0 before initialization). */
  get height(): number {
    return this.#runtime?.height ?? 0;
  }

  /** Commits pending scene edits, then opens an offline session. */
  beginOfflineAccumulation(options: OfflineAccumulationOptions = {}): void {
    const runtime = this.#runtimeOrThrow();
    this.#syncScene(runtime);
    this.#offlineRuntime(runtime.beginOfflineAccumulation).call(runtime, options);
  }

  accumulateBatch(sampleCount: number): Promise<OfflineBatchResult> {
    const runtime = this.#runtimeOrThrow();
    return this.#offlineRuntime(runtime.accumulateBatch).call(runtime, sampleCount);
  }

  readAccumulationMetrics(targetVariance: number, tileSize?: number): Promise<OfflineMetrics> {
    const runtime = this.#runtimeOrThrow();
    return this.#offlineRuntime(runtime.readAccumulationMetrics).call(
      runtime,
      targetVariance,
      tileSize,
    );
  }

  resolveOfflineHdr(options?: OfflineResolveOptions): Promise<CaptureResult> {
    const runtime = this.#runtimeOrThrow();
    return this.#offlineRuntime(runtime.resolveOfflineHdr).call(runtime, options);
  }

  /** Ends the offline session of the live runtime; never throws. */
  endOfflineAccumulation(): boolean {
    const runtime = this.#runtime;
    if (runtime === undefined || runtime.endOfflineAccumulation === undefined) {
      return false;
    }
    try {
      return runtime.endOfflineAccumulation();
    } catch {
      return false;
    }
  }

  /** HDR/AOV capture of the committed scene (see `Forge3DRuntime.capture`). */
  capture(options: CaptureOptions = {}): Promise<CaptureResult> {
    return captureOnce(this, options);
  }

  /** Native `render_offline` on the session runtime. */
  renderOffline(options: OfflineRenderOptions = {}): Promise<OfflineResult> {
    return renderOfflineTarget(this, options);
  }

  denoiseHdrFrame(
    frame: HdrFrame,
    aov?: AovFrame,
    settings?: DenoiseSettingsInput,
  ): Promise<HdrFrame> {
    const runtime = this.#runtimeOrThrow();
    return this.#offlineRuntime(runtime.denoiseHdrFrame).call(runtime, frame, aov, settings);
  }

  #offlineRuntime<T>(method: T | undefined): T {
    if (method === undefined) {
      throw new Forge3DError(
        "UNSUPPORTED_FEATURE",
        "Runtime does not support offline capture",
      );
    }
    return method;
  }

  #syncScene(runtime: SessionRuntimeLike): void {
    if (
      this.#sceneSource !== undefined &&
      !this.#sceneSource.disposed &&
      this.#sceneSource.revision !== this.#appliedRevision
    ) {
      this.#commitScene(runtime, this.#sceneSource);
    }
  }

  render(): boolean {
    const runtime = this.#runtimeOrThrow();
    this.#syncScene(runtime);
    const plan =
      this.#scene !== undefined
        ? this.#scene.getRenderPlan()
        : compileScenePasses([]);
    const start = nowMilliseconds();
    let submitted: boolean;
    try {
      submitted = runtime.render();
    } catch (error) {
      throw Forge3DError.from(error);
    }
    if (!submitted) {
      return false;
    }
    const nativeStats = readNativeRenderStats(runtime);
    if (nativeStats !== undefined) {
      this.#stats = nativeStats;
      this.#frameIndex += 1;
      return true;
    }
    const elapsed = nowMilliseconds() - start;
    const frameTimeMs =
      Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : 0;
    const passCount = plan.passes.length;
    const perPass = passCount > 0 ? frameTimeMs / passCount : 0;
    const triangles =
      this.#scene !== undefined
        ? estimateSceneTriangles(this.#scene.getNodes())
        : 0;
    this.#stats = {
      frameIndex: this.#frameIndex,
      frameTimeMs,
      drawCalls: passCount,
      triangles,
      passes: plan.passes.map((name) => ({
        name,
        milliseconds: perPass,
        timing: "cpu",
      })),
    };
    this.#frameIndex += 1;
    return true;
  }

  setCamera(camera: CameraInput): void {
    const runtime = this.#runtimeOrThrow();
    const normalized = validateCameraInput(camera);
    if (runtime.setCamera === undefined) {
      throw new Forge3DError(
        "UNSUPPORTED_FEATURE",
        "Runtime does not support cameras",
      );
    }
    runtime.setCamera(cloneCameraInput(normalized));
    this.#camera = normalized;
  }

  /** Last committed camera (replayed after device loss), if any. */
  getCamera(): CameraInput | undefined {
    return this.#camera === undefined ? undefined : cloneCameraInput(this.#camera);
  }

  readRgba(): Promise<Uint8Array> {
    const runtime = this.#runtimeOrThrow();
    if (runtime.readRgba === undefined) {
      throw new Forge3DError(
        "UNSUPPORTED_FEATURE",
        "Runtime does not support readback",
      );
    }
    return runtime.readRgba();
  }

  resize(size: ResizeInput): void {
    const runtime = this.#runtimeOrThrow();
    validateExplicitResize(size);
    runtime.resize?.({ ...size });
  }

  screenshot(): Promise<Blob> {
    const runtime = this.#runtimeOrThrow();
    if (runtime.screenshot === undefined) {
      throw new Forge3DError(
        "UNSUPPORTED_FEATURE",
        "Runtime does not support screenshots",
      );
    }
    return runtime.screenshot();
  }

  whenReady(): Promise<void> {
    if (this.#status === "ready") {
      return Promise.resolve();
    }
    if (this.#status === "failed" || this.#status === "disposed") {
      return Promise.reject(this.#retainedError());
    }
    return new Promise((resolve, reject) => {
      this.#readyWaiters.push({ resolve, reject });
    });
  }

  dispose(): void {
    if (this.#status === "disposed") {
      return;
    }
    this.#generation += 1;
    this.#status = "disposed";
    this.#terminalError = new Forge3DError(
      "RUNTIME_DISPOSED",
      "Session is disposed",
    );
    this.#detachLoss?.();
    this.#detachLoss = undefined;
    const runtime = this.#runtime;
    this.#runtime = undefined;
    try {
      runtime?.dispose();
    } catch {}
    this.#tracker.clear();
    const waiters = this.#readyWaiters.splice(0);
    for (const waiter of waiters) {
      waiter.reject(this.#terminalError);
    }
  }

  async #initialize(): Promise<void> {
    try {
      const factory = sessionRuntimeFactory ?? defaultSessionRuntimeFactory;
      const runtime = await factory(
        this.#canvas,
        this.#resolvedRuntimeOptions(),
      );
      if (this.#status === "disposed") {
        try {
          runtime.dispose();
        } catch {}
        throw new Forge3DError("RUNTIME_DISPOSED", "Session is disposed");
      }
      this.#runtime = runtime;
      try {
        this.#capabilitiesBase = runtime.getCapabilities();
        this.#attachLossHandler(runtime);
      } catch (error) {
        this.#detachLoss?.();
        this.#detachLoss = undefined;
        this.#runtime = undefined;
        try {
          runtime.dispose();
        } catch {}
        throw error;
      }
      this.#status = "ready";
      this.#flushReadyWaiters();
    } catch (error) {
      const normalized = Forge3DError.from(error);
      this.#terminalError = normalized;
      this.#status = "failed";
      this.#flushReadyWaiters();
      throw normalized;
    }
  }

  #commitScene(runtime: SessionRuntimeLike, scene: Forge3DScene): void {
    const copy = scene.copy();
    applyRendererConfigMaterials(copy, this.#config.toJSON());
    applyRendererConfigShadows(copy, this.#config.toJSON());
    const estimatedBytes = copy.estimatedGpuBytes();
    const snapshot = copy.snapshot();
    const config = this.#config.toJSON();
    const previous = this.#sceneReservation;
    const previousScene = this.#scene;
    const previousSnapshot = this.#committedSnapshot;

    this.#tracker.release(SCENE_ALLOCATION_KEY);
    let applied = false;
    try {
      if (estimatedBytes > 0) {
        this.#tracker.allocate(
          SCENE_ALLOCATION_KEY,
          "buffers",
          estimatedBytes,
          config.quality,
          config.overflowPolicy,
        );
      }
      applied = true;
      this.#applyCommittedScene(runtime, copy, snapshot);
    } catch (error) {
      this.#tracker.release(SCENE_ALLOCATION_KEY);
      if (previous !== undefined) {
        try {
          this.#tracker.allocate(
            SCENE_ALLOCATION_KEY,
            "buffers",
            previous.requestedBytes,
            config.quality,
            config.overflowPolicy,
          );
        } catch {}
      }
      if (
        applied &&
        previousScene !== undefined &&
        previousSnapshot !== undefined
      ) {
        try {
          this.#applyCommittedScene(runtime, previousScene, previousSnapshot);
        } catch {}
      }
      throw Forge3DError.from(error);
    }

    this.#scene = copy;
    this.#sceneSource = scene;
    this.#appliedRevision = scene.revision;
    this.#committedSnapshot = snapshot;
    this.#sceneReservation =
      estimatedBytes > 0 ? { requestedBytes: estimatedBytes } : undefined;
  }

  #applyCommittedScene(
    runtime: SessionRuntimeLike,
    scene: Forge3DScene,
    snapshot: SceneSnapshot,
  ): void {
    for (const node of scene.getNodes()) {
      if (node.node.kind === "terrain") {
        runtime.setTerrain?.(clonePayload(node.node.terrain));
      }
    }
    if (runtime.setScene !== undefined) {
      runtime.setScene(snapshot);
      return;
    }
    runtime.setLighting?.(clonePayload(snapshot.lighting));
    runtime.setMaterials?.(clonePayload(snapshot.materials));
    runtime.setIbl?.(clonePayload(snapshot.ibl));
    runtime.setShadows?.(clonePayload(snapshot.shadows));
  }

  #attachLossHandler(runtime: SessionRuntimeLike): void {
    const handler = (error: unknown) => {
      this.#onDeviceLost(Forge3DError.from(error));
    };
    if (typeof runtime.setDeviceLostHandler === "function") {
      runtime.setDeviceLostHandler(handler);
      this.#detachLoss = () => runtime.setDeviceLostHandler?.(undefined);
      return;
    }
    if (runtime instanceof Forge3DRuntime) {
      setRuntimeDeviceLostHandler(runtime, handler);
      this.#detachLoss = () => setRuntimeDeviceLostHandler(runtime, undefined);
      return;
    }
    this.#detachLoss = undefined;
  }

  #onDeviceLost(error: Forge3DError): void {
    if (this.#status !== "ready") {
      return;
    }
    const normalized =
      error.code === "DEVICE_LOST"
        ? error
        : new Forge3DError("DEVICE_LOST", error.message, error.details);
    this.#terminalError = normalized;
    if (this.#capabilitiesBase !== undefined) {
      this.#capabilitiesBase = {
        ...this.#capabilitiesBase,
        deviceState: "lost",
      };
    }
    if (this.#recoveryMode === "none" || this.#recoveryAttempts >= 1) {
      this.#fail(normalized);
      return;
    }
    this.#recoveryAttempts += 1;
    this.#status = "recovering";
    const generation = ++this.#generation;
    const lost = this.#runtime;
    this.#runtime = undefined;
    this.#detachLoss?.();
    this.#detachLoss = undefined;
    try {
      lost?.dispose();
    } catch {}
    const recovery = this.#recover(generation);
    this.#recoveryPromise = recovery;
    void recovery.then(
      () => this.#finishRecovery(recovery),
      () => this.#finishRecovery(recovery),
    );
  }

  async #recover(generation: number): Promise<void> {
    try {
      const factory = sessionRuntimeFactory ?? defaultSessionRuntimeFactory;
      const replacement = await factory(
        this.#canvas,
        this.#resolvedRuntimeOptions(),
      );
      if (this.#status !== "recovering" || generation !== this.#generation) {
        try {
          replacement.dispose();
        } catch {}
        return;
      }
      this.#runtime = replacement;
      try {
        this.#capabilitiesBase = replacement.getCapabilities();
        this.#attachLossHandler(replacement);
        if (
          this.#committedSnapshot !== undefined &&
          this.#scene !== undefined
        ) {
          this.#applyCommittedScene(
            replacement,
            this.#scene,
            this.#committedSnapshot,
          );
        }
        if (this.#camera !== undefined) {
          replacement.setCamera?.(cloneCameraInput(this.#camera));
        }
      } catch (error) {
        this.#detachLoss?.();
        this.#detachLoss = undefined;
        this.#runtime = undefined;
        try {
          replacement.dispose();
        } catch {}
        throw error;
      }
      this.#terminalError = undefined;
      this.#status = "ready";
    } catch (error) {
      if (this.#status !== "disposed") {
        const normalized = Forge3DError.from(error);
        this.#terminalError =
          normalized.code === "DEVICE_LOST"
            ? normalized
            : new Forge3DError("DEVICE_LOST", "Session recovery failed", {
                cause: normalized,
              });
        this.#status = "failed";
      }
    }
  }

  #finishRecovery(recovery: Promise<void>): void {
    if (this.#recoveryPromise !== recovery) {
      return;
    }
    this.#recoveryPromise = undefined;
    this.#flushReadyWaiters();
  }

  #fail(error: Forge3DError): void {
    this.#terminalError = error;
    this.#status = "failed";
    this.#flushReadyWaiters();
  }

  #flushReadyWaiters(): void {
    const waiters = this.#readyWaiters.splice(0);
    if (waiters.length === 0) {
      return;
    }
    if (this.#status === "ready") {
      for (const waiter of waiters) {
        waiter.resolve();
      }
      return;
    }
    if (this.#status === "failed" || this.#status === "disposed") {
      const error = this.#retainedError();
      for (const waiter of waiters) {
        waiter.reject(error);
      }
    }
  }

  #retainedError(): Forge3DError {
    return (
      this.#terminalError ??
      new Forge3DError("INTERNAL_ERROR", "Session is not ready")
    );
  }

  #runtimeOrThrow(): SessionRuntimeLike {
    if (this.#status === "disposed") {
      throw new Forge3DError("RUNTIME_DISPOSED", "Session is disposed");
    }
    if (this.#status === "failed" || this.#status === "recovering") {
      throw this.#retainedError();
    }
    const runtime = this.#runtime;
    if (runtime === undefined) {
      throw this.#retainedError();
    }
    return runtime;
  }

  #resolvedRuntimeOptions(): Forge3DRuntimeOptions {
    const config = this.#config.toJSON();
    return {
      ...(this.#options.runtime ?? {}),
      quality: config.quality,
      memoryBudgetBytes: config.memoryBudgetBytes,
      overflowPolicy: config.overflowPolicy,
      timestampMode: config.timestampMode,
    };
  }
}

async function defaultSessionRuntimeFactory(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  options: Forge3DRuntimeOptions,
): Promise<SessionRuntimeLike> {
  return Forge3DRuntime.create(canvas, options);
}

function readNativeRenderStats(
  runtime: SessionRuntimeLike,
): RenderStats | undefined {
  if (runtime.getRenderStats === undefined) {
    return undefined;
  }
  try {
    return normalizeRenderStats(runtime.getRenderStats());
  } catch {
    return undefined;
  }
}

function globalConstructor(name: string): unknown {
  return (globalThis as Record<string, unknown>)[name];
}

function hasOffscreenCanvas(): boolean {
  return typeof globalConstructor("OffscreenCanvas") === "function";
}

function hasWorkers(): boolean {
  return typeof globalConstructor("Worker") === "function";
}

function hasSharedArrayBuffer(): boolean {
  return (
    typeof globalConstructor("SharedArrayBuffer") === "function" &&
    (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated ===
      true
  );
}

function hasFileSystemAccess(): boolean {
  return typeof globalConstructor("showSaveFilePicker") === "function";
}

function hasOpfs(): boolean {
  const navigatorLike = (
    globalThis as {
      navigator?: { storage?: { getDirectory?: unknown } };
    }
  ).navigator;
  return typeof navigatorLike?.storage?.getDirectory === "function";
}

function normalizeAdapterInfo(info: AdapterInfo | undefined): AdapterInfo {
  return {
    name: info?.name ?? "",
    vendor: info?.vendor ?? "",
    architecture: info?.architecture ?? "",
    device: info?.device ?? "",
    description: info?.description ?? "",
    backend: info?.backend ?? "browser-webgpu",
    deviceType: info?.deviceType ?? "unknown",
  };
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}


function applyRendererConfigMaterials(
  scene: Forge3DScene,
  config: RendererConfigData,
): void {
  const shadingBrdf = config.brdfOverride ?? config.shading.brdf;
  scene.setMaterial("default", {
    id: "default",
    brdf: shadingBrdf,
    baseColor: [1, 1, 1, 1],
    metallic: config.shading.metallic,
    roughness: config.shading.roughness,
    sheen: 0,
    clearcoat: 0,
    subsurface: 0,
    anisotropy: 0,
  });
  for (const [slot, entry] of Object.entries(config.materials)) {
    const parameters = entry.parameters;
    const numeric = (key: string): number | undefined => {
      const value = parameters[key];
      return typeof value === "number" && Number.isFinite(value)
        ? value
        : undefined;
    };
    const brdfParameter = parameters["brdf"];
    const baseColorParameter = parameters["baseColor"];
    const baseColor: [number, number, number, number] =
      Array.isArray(baseColorParameter) &&
      baseColorParameter.length === 4 &&
      baseColorParameter.every(
        (component) =>
          typeof component === "number" && Number.isFinite(component),
      )
        ? baseColorParameter
        : [1, 1, 1, 1];
    scene.setMaterial(slot, {
      id: entry.id,
      brdf:
        typeof brdfParameter === "string" && brdfParameter.length > 0
          ? brdfParameter
          : shadingBrdf,
      baseColor,
      metallic: numeric("metallic") ?? config.shading.metallic,
      roughness: numeric("roughness") ?? config.shading.roughness,
      sheen: numeric("sheen") ?? 0,
      clearcoat: numeric("clearcoat") ?? 0,
      subsurface: numeric("subsurface") ?? 0,
      anisotropy: numeric("anisotropy") ?? 0,
    });
  }
}

function applyRendererConfigShadows(
  scene: Forge3DScene,
  config: RendererConfigData,
): void {
  if (sceneShadowsConfigured(scene)) {
    return;
  }
  const shadows = config.shadows;
  const technique = shadows.technique.trim().toLowerCase();
  const cascades = shadows.cascades;
  scene.setShadows(
    {
      enabled: shadows.enabled,
      filter: technique,
      mapSize: shadows.mapSize,
    },
    {
      enabled: shadows.enabled && technique !== "none" && cascades > 1,
      cascadeCount: cascades > 1 ? (cascades as 2 | 3 | 4) : 3,
    },
  );
}

function nowMilliseconds(): number {
  const performanceLike = (
    globalThis as typeof globalThis & {
      performance?: { now?: () => number };
    }
  ).performance;
  if (typeof performanceLike?.now === "function") {
    return performanceLike.now();
  }
  return Date.now();
}
