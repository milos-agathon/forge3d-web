import { Forge3DScene } from "./scene.js";
import { LightCollection } from "./lighting.js";
import type { LabelLayer, LabelPlacementReport, LabelRenderOptions } from './labels.js';
import { Forge3DEnvironment, normalizeEnvironment } from "./environment.js";
import type { EnvironmentInput, EnvironmentSnapshot, EnvironmentMemoryReport } from "./environment.js";
import {
  type SceneSnapshot,
  type CameraControllerMode,
  type CameraInput,
  type CameraInputEvent,
  type CameraProjectionKind,
  Forge3DError,
  Forge3DRuntime,
  normalizeTerrainMaterial,
  type FlyView,
  type Forge3DRuntimeCapabilities,
  type Forge3DRuntimeOptions,
  type Forge3DViewerOptions,
  type HeightAoOptions,
  type HeightStreamingStats,
  type HeightTileCompletion,
  type HeightTilePlan,
  type LodSelectionReport,
  type MaterialVtSourceImage,
  type OrbitView,
  type ResizeInput,
  type SunVisibilityOptions,
  type TerrainColorRampInput,
  type TerrainColormapInput,
  type TerrainDebugView,
  type TerrainGeometryInput,
  type TerrainGeometryReport,
  type TerrainHeightmapInput,
  type TerrainHeightmapSourceInput,
  type TerrainMaterialInput,
  type TerrainMaterialVtStats,
  type TerrainOverlayReport,
  type TerrainOverlaysInput,
  type TerrainStreamingInput,
  type ViewerCapabilities,
  type ViewerDiagnostics,
  type ViewerResourceBudget,
  type ViewerStatus,
} from "./index.js";
import { OrbitController } from "./orbit-controller.js";
import { TerrainScatterBatch, normalizeScatterBatches, type ScatterBatchInput, type ScatterBatchSnapshot, type ScatterFrameStats, type ScatterMemoryReport } from "./terrain-scatter.js";
import { TerrainLightingProbes, validateProbeSnapshot, type TerrainProbeSnapshot, type TerrainProbeMemoryReport } from "./terrain-probes.js";
import { CameraController } from "./camera-controllers.js";
import { validateCameraInput } from "./camera.js";
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
  setScene?(scene: SceneSnapshot): void;
  setEnvironment?(snapshot: EnvironmentSnapshot|null):void;
  getEnvironmentMemoryReport?():EnvironmentMemoryReport;
  setScatterBatches?(batches: ScatterBatchSnapshot[]): void;
  setLightingProbes?(probes: TerrainProbeSnapshot | null): void;
  setTimeSeconds?(seconds: number): void;
  getScatterStats?(): ScatterFrameStats;
  getScatterMemoryReport?(): ScatterMemoryReport;
  getProbeMemoryReport?(): TerrainProbeMemoryReport;
  setTerrainFromSource(terrain: TerrainHeightmapSourceInput): Promise<void>;
  setCamera(camera: CameraInput): void;
  resize(size: ResizeInput): void;
  render(): boolean;
  screenshot(): Promise<Blob>;
  getTerrainGeometryReport?(): TerrainGeometryReport;
  getTerrainOverlayReport?(): TerrainOverlayReport;
  planHeightTiles?(maxRequests: number): HeightTilePlan;
  completeHeightTile?(
    lod: number,
    x: number,
    y: number,
    heights: Float32Array,
  ): HeightTileCompletion;
  failHeightTile?(lod: number, x: number, y: number): void;
  getHeightStreamingStats?(): HeightStreamingStats;
  getLodSelection?(): LodSelectionReport | null;
  registerMaterialVtSource?(
    materialIndex: number,
    family: string,
    image: MaterialVtSourceImage,
    fallback?: [number, number, number, number],
  ): void;
  clearMaterialVtSources?(): void;
  getMaterialVtStats?(): TerrainMaterialVtStats;
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
  readonly #camera: CameraController;
  #projection: CameraProjectionKind = "perspective";
  #orthographicHeight: number | undefined;
  readonly #budget: ViewerResourceBudget;
  readonly #maxDevicePixelRatio: number;
  readonly #recoveryMode: "none" | "once";
  readonly #resources = new OwnedDomResources();

  #runtime: ViewerRuntime | undefined;
  #controls: ViewerControls | undefined;
  #scheduler: RenderScheduler | undefined;
  #resizeController: ResizeController | undefined;
  /** W08: registered VT sources retained across device-loss replay. */
  readonly #vtSources = new Map<
    string,
    {
      materialIndex: number;
      family: string;
      image: MaterialVtSourceImage;
      fallback?: [number, number, number, number];
    }
  >();
  readonly #frameListeners = new Set<
    (timestamp: number) => boolean | void
  >();
  readonly #recoveryListeners = new Set<() => void>();
  #labelLayer: LabelLayer | undefined;
  #labelScene: Forge3DScene | undefined;
  #labelOptions: Omit<LabelRenderOptions,"viewport"|"camera"> = {};
  #labelSignature = "";
  #labelFailureSignature = "";
  #labelUnsubscribe: (()=>void) | undefined;
  #labelReport: LabelPlacementReport | undefined;
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
  #environmentReplay:EnvironmentSnapshot|null|undefined;
  #scatterReplay: ScatterBatchSnapshot[] | undefined;
  #probeReplay: TerrainProbeSnapshot | null | undefined;
  #scatterTime = 0;
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
    const controls = options.controls === false ? undefined : options.controls;
    this.#camera = new CameraController(
      {
        ...(controls?.mode !== undefined ? { mode: controls.mode } : {}),
        ...(controls?.fly !== undefined ? { flyOptions: controls.fly } : {}),
        ...(controls?.bindings !== undefined ? { bindings: controls.bindings } : {}),
        ...(options.initialFlyView !== undefined ? { fly: options.initialFlyView } : {}),
      },
      this.#controller,
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

  /** Active controller mode (`"orbit"` or `"fly"`). */
  getCameraMode(): CameraControllerMode {
    return this.#camera.mode;
  }

  /** Switches between orbit and fly control, keeping the view continuous. */
  setCameraMode(mode: CameraControllerMode): void {
    const runtime = this.#operationalRuntime();
    if (this.#camera.setMode(mode)) {
      this.#pushCamera(runtime);
    }
  }

  getFlyView(): FlyView {
    return this.#camera.fly.getView();
  }

  setFlyView(view: FlyView): void {
    const runtime = this.#operationalRuntime();
    this.#camera.fly.setView(view);
    this.#pushCamera(runtime);
  }

  setLabels(layer: LabelLayer | null, options: Omit<LabelRenderOptions, "viewport" | "camera"> = {}): void {
    const runtime = this.#operationalRuntime();
    if (!runtime.setScene) throw new Forge3DError("UNSUPPORTED_FEATURE", "Runtime cannot render label layers");
    if (this.#labelLayer && this.#labelScene) this.#labelLayer.detach(this.#labelScene);
    this.#labelUnsubscribe?.();
    this.#labelUnsubscribe = undefined;
    this.#labelLayer = layer ?? undefined;
    if (layer) this.#labelUnsubscribe = layer.addChangeListener(() => this.#scheduler?.requestRender());
    this.#labelOptions = {...options};
    this.#labelSignature = "";
    this.#labelFailureSignature = "";
    if (!this.#labelScene) {
      this.#labelScene = Forge3DScene.create();
      // A scene starts with only the key; the viewer runtime also has a fill.
      for (const light of LightCollection.defaults().values().slice(1)) {
        this.#labelScene.addLight(light);
      }
    }
    try {
      this.#callRuntime(() => this.#refreshLabels(runtime));
    } finally {
      this.#scheduler?.requestRender();
    }
  }

  getLabelReport(): LabelPlacementReport | undefined {
    return this.#labelReport ? structuredClone(this.#labelReport) : undefined;
  }

  #commitLabelScene(runtime: ViewerRuntime): void {
    const scene = this.#labelScene!;
    if (this.#environmentReplay !== undefined) scene.setEnvironment(this.#environmentReplay);
    if (this.#scatterReplay !== undefined) scene.setScatterBatches(this.#scatterReplay);
    if (this.#probeReplay !== undefined) scene.setLightingProbes(this.#probeReplay);
    scene.setTimeSeconds(this.#scatterTime);
    runtime.setScene!(scene.snapshot());
  }
  #clearLabelScene(): void {
    const scene = this.#labelScene!;
    this.#labelLayer?.detach(scene);
    for (const node of scene.getNodes()) scene.removeNode(node.id);
    this.#labelReport = undefined;
  }
  #refreshLabels(runtime: ViewerRuntime, reportOnly = false): void {
    if (!this.#labelScene || !runtime.setScene) return;
    const camera = this.#effectiveCamera();
    const state = JSON.stringify([this.#labelLayer?.revision ?? -1, this.#labelLayer?.disposed ?? false]);
    const signature = JSON.stringify([state, camera, runtime.width, runtime.height]);
    if (signature === this.#labelSignature) return;
    // Failed label state remains empty across camera/size changes and recovery.
    // Only a layer edit or explicit setLabels call retries label generation.
    if (state === this.#labelFailureSignature) {
      this.#clearLabelScene();
      this.#commitLabelScene(runtime);
      this.#labelSignature = signature;
      return;
    }
    this.#labelFailureSignature = "";
    try {
      let report: LabelPlacementReport | undefined;
      if (this.#labelLayer && !this.#labelLayer.disposed) {
        report = this.#labelLayer.attach(this.#labelScene, {
          ...this.#labelOptions, camera, viewport: {width: runtime.width, height: runtime.height},
        });
      } else {
        this.#clearLabelScene();
      }
      this.#commitLabelScene(runtime);
      this.#labelReport = report;
      this.#labelSignature = signature;
    } catch (error) {
      const normalized = Forge3DError.from(error);
      if (normalized.code === "DEVICE_LOST") throw normalized;
      this.#clearLabelScene();
      // If clearing itself fails, propagate the runtime error; stale GPU nodes
      // cannot be treated as a successfully recovered label state.
      this.#commitLabelScene(runtime);
      this.#labelFailureSignature = state;
      this.#labelSignature = signature;
      this.#emitError(normalized);
      if (!reportOnly) throw normalized;
    }
  }
  #refreshLabelsSafely(runtime: ViewerRuntime): void {
    // Only label errors followed by a successful empty-scene commit are caught.
    // Runtime/device errors during the clear still reach the runtime handler.
    this.#refreshLabels(runtime, true);
  }
  /** Camera currently rendered (active controller plus projection). */
  getCamera(): CameraInput {
    return this.#effectiveCamera();
  }

  /**
   * Points both controllers at `camera` and adopts its projection; the
   * active mode is kept. Controllers are Y-up, so `camera.up` must be +Y.
   */
  setCamera(camera: CameraInput): void {
    const runtime = this.#operationalRuntime();
    const checked = validateCameraInput(camera);
    const upLength = Math.hypot(checked.up[0], checked.up[1], checked.up[2]);
    if (
      Math.abs(checked.up[0]) > 1e-6 * upLength ||
      Math.abs(checked.up[2]) > 1e-6 * upLength ||
      checked.up[1] <= 0
    ) {
      throw new Forge3DError(
        "INVALID_INPUT",
        "viewer cameras are Y-up; camera.up must point along +Y",
      );
    }
    this.#camera.setCamera(checked);
    this.#projection = checked.projection ?? "perspective";
    this.#orthographicHeight = checked.orthographicHeight;
    this.#pushCamera(runtime);
  }

  /** Records every camera input event applied from now on. */
  startCameraRecording(): void {
    this.#camera.startRecording();
  }

  /** Stops recording and returns the recorded, serializable events. */
  stopCameraRecording(): CameraInputEvent[] {
    return this.#camera.stopRecording();
  }

  /** Applies recorded camera input events deterministically. */
  replayCameraInput(events: readonly CameraInputEvent[]): void {
    const runtime = this.#operationalRuntime();
    this.#camera.replay(events);
    this.#pushCamera(runtime);
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

  /** W08: forward `getTerrainGeometryReport` to the live runtime. */
  getTerrainGeometryReport(): TerrainGeometryReport {
    const runtime = this.#operationalRuntime();
    return this.#callRuntime(() => {
      const report = runtime.getTerrainGeometryReport?.();
      if (report === undefined) {
        throw new Forge3DError(
          "UNSUPPORTED_FEATURE",
          "Runtime does not report terrain geometry",
        );
      }
      return report;
    });
  }

  /** W08: forward `getTerrainOverlayReport` to the live runtime. */
  getTerrainOverlayReport(): TerrainOverlayReport {
    const runtime = this.#operationalRuntime();
    return this.#callRuntime(() => {
      const report = runtime.getTerrainOverlayReport?.();
      if (report === undefined) {
        throw new Forge3DError(
          "UNSUPPORTED_FEATURE",
          "Runtime does not report terrain overlays",
        );
      }
      return report;
    });
  }

  /** W08: forward `planHeightTiles` — used by `TerrainStreamer`. */
  planHeightTiles(maxRequests: number): HeightTilePlan {
    const runtime = this.#operationalRuntime();
    return this.#callRuntime(() => {
      const plan = runtime.planHeightTiles?.(maxRequests);
      if (plan === undefined) {
        throw new Forge3DError(
          "UNSUPPORTED_FEATURE",
          "Runtime does not implement height streaming",
        );
      }
      return plan;
    });
  }

  /** W08: forward `completeHeightTile` — used by `TerrainStreamer`. */
  completeHeightTile(
    lod: number,
    x: number,
    y: number,
    heights: Float32Array,
  ): HeightTileCompletion {
    const runtime = this.#operationalRuntime();
    return this.#callRuntime(() => {
      const completion = runtime.completeHeightTile?.(lod, x, y, heights);
      if (completion === undefined) {
        throw new Forge3DError(
          "UNSUPPORTED_FEATURE",
          "Runtime does not implement height streaming",
        );
      }
      return completion;
    });
  }

  /** W08: forward `failHeightTile` — used by `TerrainStreamer`. */
  failHeightTile(lod: number, x: number, y: number): void {
    const runtime = this.#operationalRuntime();
    this.#callRuntime(() => {
      if (runtime.failHeightTile === undefined) {
        throw new Forge3DError(
          "UNSUPPORTED_FEATURE",
          "Runtime does not implement height streaming",
        );
      }
      runtime.failHeightTile(lod, x, y);
    });
  }

  /** W08: forward `getHeightStreamingStats`. */
  getHeightStreamingStats(): HeightStreamingStats {
    const runtime = this.#operationalRuntime();
    return this.#callRuntime(() => {
      const stats = runtime.getHeightStreamingStats?.();
      if (stats === undefined) {
        throw new Forge3DError(
          "UNSUPPORTED_FEATURE",
          "Runtime does not implement height streaming",
        );
      }
      return stats;
    });
  }

  /** W08: forward `getLodSelection`. */
  getLodSelection(): LodSelectionReport | null {
    const runtime = this.#operationalRuntime();
    return this.#callRuntime(() => {
      if (runtime.getLodSelection === undefined) {
        throw new Forge3DError(
          "UNSUPPORTED_FEATURE",
          "Runtime does not implement height streaming",
        );
      }
      return runtime.getLodSelection();
    });
  }

  setEnvironment(
    input: Forge3DEnvironment | EnvironmentInput | EnvironmentSnapshot | null,
  ): void {
    const runtime = this.#operationalRuntime();
    const snapshot =
      input === null
        ? null
        : input instanceof Forge3DEnvironment
          ? input.snapshot()
          : normalizeEnvironment(input);
    this.#callRuntime(() => {
      if (!runtime.setEnvironment)
        throw new Forge3DError(
          "UNSUPPORTED_FEATURE",
          "Runtime does not support environment",
        );
      runtime.setEnvironment(snapshot);
    });
    this.#environmentReplay = structuredClone(snapshot);
    this.#scheduler?.requestRender();
  }
  getEnvironmentMemoryReport(): EnvironmentMemoryReport {
    const runtime = this.#operationalRuntime();
    return this.#callRuntime(() => {
      if (!runtime.getEnvironmentMemoryReport)
        throw new Forge3DError(
          "UNSUPPORTED_FEATURE",
          "Runtime does not report environment memory",
        );
      return runtime.getEnvironmentMemoryReport();
    });
  }
  setScatterBatches(batches: readonly (TerrainScatterBatch | ScatterBatchInput | ScatterBatchSnapshot)[]): void {
    const runtime = this.#operationalRuntime(), snapshot = normalizeScatterBatches(batches);
    this.#callRuntime(() => { if (!runtime.setScatterBatches) throw new Forge3DError("UNSUPPORTED_FEATURE", "Runtime does not support terrain scatter"); runtime.setScatterBatches(snapshot); });
    this.#scatterReplay = structuredClone(snapshot); this.#scheduler?.requestRender();
  }

  setLightingProbes(probes: TerrainLightingProbes | TerrainProbeSnapshot | null): void {
    const runtime = this.#operationalRuntime(), snapshot = probes instanceof TerrainLightingProbes ? probes.snapshot() : structuredClone(probes);
    if (snapshot) validateProbeSnapshot(snapshot);
    this.#callRuntime(() => { if (!runtime.setLightingProbes) throw new Forge3DError("UNSUPPORTED_FEATURE", "Runtime does not support terrain probes"); runtime.setLightingProbes(snapshot); });
    this.#probeReplay = structuredClone(snapshot); this.#scheduler?.requestRender();
  }

  setTimeSeconds(seconds: number): void {
    const runtime = this.#operationalRuntime();
    if (!Number.isFinite(seconds)) throw new Forge3DError("INVALID_INPUT", "timeSeconds must be finite");
    this.#callRuntime(() => { if (!runtime.setTimeSeconds) throw new Forge3DError("UNSUPPORTED_FEATURE", "Runtime does not support scatter time"); runtime.setTimeSeconds(seconds); });
    this.#scatterTime = seconds; this.#scheduler?.requestRender();
  }

  getScatterStats(): ScatterFrameStats { const runtime = this.#operationalRuntime(); return this.#callRuntime(() => { if (!runtime.getScatterStats) throw new Forge3DError("UNSUPPORTED_FEATURE", "Runtime does not report scatter"); return runtime.getScatterStats(); }); }
  getScatterMemoryReport(): ScatterMemoryReport { const runtime = this.#operationalRuntime(); return this.#callRuntime(() => { if (!runtime.getScatterMemoryReport) throw new Forge3DError("UNSUPPORTED_FEATURE", "Runtime does not report scatter"); return runtime.getScatterMemoryReport(); }); }
  getProbeMemoryReport(): TerrainProbeMemoryReport { const runtime = this.#operationalRuntime(); return this.#callRuntime(() => { if (!runtime.getProbeMemoryReport) throw new Forge3DError("UNSUPPORTED_FEATURE", "Runtime does not report probes"); return runtime.getProbeMemoryReport(); }); }

  /** W08: forward `registerMaterialVtSource`; the registration is
   * retained and replayed after device-loss recovery. */
  registerMaterialVtSource(
    materialIndex: number,
    family: string,
    image: MaterialVtSourceImage,
    fallback?: [number, number, number, number],
  ): void {
    const runtime = this.#operationalRuntime();
    this.#callRuntime(() => {
      if (runtime.registerMaterialVtSource === undefined) {
        throw new Forge3DError(
          "UNSUPPORTED_FEATURE",
          "Runtime does not implement material virtual texturing",
        );
      }
      runtime.registerMaterialVtSource(materialIndex, family, image, fallback);
    });
    this.#vtSources.set(`${materialIndex}:${family}`, {
      materialIndex,
      family,
      image: cloneVtSourceImage(image),
      ...(fallback !== undefined ? { fallback: [...fallback] } : {}),
    });
  }

  /** W08: forward `clearMaterialVtSources`; also clears the retained
   * replay set. */
  clearMaterialVtSources(): void {
    const runtime = this.#operationalRuntime();
    this.#callRuntime(() => {
      if (runtime.clearMaterialVtSources === undefined) {
        throw new Forge3DError(
          "UNSUPPORTED_FEATURE",
          "Runtime does not implement material virtual texturing",
        );
      }
      runtime.clearMaterialVtSources();
    });
    this.#vtSources.clear();
  }

  /** W08: forward `getMaterialVtStats`. */
  getMaterialVtStats(): TerrainMaterialVtStats {
    const runtime = this.#operationalRuntime();
    return this.#callRuntime(() => {
      const stats = runtime.getMaterialVtStats?.();
      if (stats === undefined) {
        throw new Forge3DError(
          "UNSUPPORTED_FEATURE",
          "Runtime does not implement material virtual texturing",
        );
      }
      return stats;
    });
  }

  /** Registers `listener` invoked once per successfully completed
   * device-loss recovery (after the terrain/VT replay). Returns an
   * unsubscribe function. Used by `TerrainStreamer`. */
  addRecoveryListener(listener: () => void): () => void {
    this.#recoveryListeners.add(listener);
    return () => {
      this.#recoveryListeners.delete(listener);
    };
  }

  /** Registers `listener` invoked each submitted frame; returning
   * `true` keeps the render loop alive. Used by `TerrainStreamer`'s
   * `autoUpdate`. Returns an unsubscribe function. */
  addFrameListener(
    listener: (timestamp: number) => boolean | void,
  ): () => void {
    this.#frameListeners.add(listener);
    return () => {
      this.#frameListeners.delete(listener);
    };
  }

  /** Schedules a render on the viewer's scheduler (no-op when the
   * scheduler is suspended or the viewer is recovering). */
  requestRender(): void {
    this.#scheduler?.requestRender();
  }

  setView(view: OrbitView): void {
    const runtime = this.#operationalRuntime();
    this.#controller.setView(view);
    this.#pushCamera(runtime);
  }

  /** Resets the active controller (orbit or fly) to its initial view. */
  resetView(): void {
    const runtime = this.#operationalRuntime();
    this.#camera.apply({ type: "reset" });
    this.#pushCamera(runtime);
  }

  #effectiveCamera(): CameraInput {
    const camera = this.#camera.getCamera();
    if (this.#projection === "orthographic") {
      camera.projection = "orthographic";
      camera.orthographicHeight = this.#orthographicHeight ?? 1;
    }
    return camera;
  }

  #pushCamera(runtime: ViewerRuntime): void {
    this.#callRuntime(() => runtime.setCamera(this.#effectiveCamera()));
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
    this.#callRuntime(() => runtime.setCamera(this.#effectiveCamera()));
    const promise = Promise.resolve().then(() => {
      this.#refreshLabels(runtime);
      return runtime.screenshot();
    }).catch((error: unknown) => {
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
    if(this.#labelLayer&&this.#labelScene)this.#labelLayer.detach(this.#labelScene);
    this.#labelUnsubscribe?.();this.#labelUnsubscribe=undefined;
    this.#labelScene?.dispose();this.#labelScene=undefined;this.#labelLayer=undefined;
    this.#vtSources.clear();
    this.#frameListeners.clear();
    this.#recoveryListeners.clear();
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
    runtime.setCamera(this.#effectiveCamera());
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
        this.#refreshLabelsSafely(current);
        return current.render();
      },
      canRender: () =>
        this.#status === "ready" &&
        this.#runtime !== undefined &&
        !this.#resizeController?.suspended,
      onError: (error) => this.#handleRuntimeError(Forge3DError.from(error)),
      onFrame: (timestamp) => {
        let pending =
          this.#controls?.onAnimationFrame(timestamp) ?? false;
        for (const listener of this.#frameListeners) {
          try {
            pending = listener(timestamp) === true || pending;
          } catch {
            // A frame listener must not break the render loop.
          }
        }
        return pending;
      },
      resources: this.#resources,
    });

    if (this.#options.controls !== false) {
      this.#controls = new ViewerControls(
        this.#canvas,
        this.#camera,
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
              current.setCamera(this.#effectiveCamera()),
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
      replacement.setCamera(this.#effectiveCamera());
      this.#labelSignature="";
      this.#refreshLabelsSafely(replacement);
      if (this.#runtime !== replacement || recoveryController.signal.aborted) {
        return;
      }
      if (this.#lastSize !== undefined) {
        replacement.resize(this.#lastSize);
      }
      if (this.#runtime !== replacement || recoveryController.signal.aborted) {
        return;
      }
      // W08: replay the retained VT sources before the terrain: the runtime
      // snapshots VT sources when a terrain is committed, so sources
      // registered after `setTerrain` would never reach the replayed frame.
      for (const source of this.#vtSources.values()) {
        replacement.registerMaterialVtSource?.(
          source.materialIndex,
          source.family,
          cloneVtSourceImage(source.image),
          source.fallback === undefined
            ? undefined
            : [...source.fallback],
        );
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
      if(this.#environmentReplay!==undefined){if(!replacement.setEnvironment)throw new Forge3DError("UNSUPPORTED_FEATURE","Recovery runtime does not support environment");replacement.setEnvironment(structuredClone(this.#environmentReplay));}
      if (this.#scatterReplay !== undefined) {
        if (!replacement.setScatterBatches || !replacement.setTimeSeconds) throw new Forge3DError("UNSUPPORTED_FEATURE", "Recovery runtime does not support terrain scatter");
        replacement.setScatterBatches(structuredClone(this.#scatterReplay)); replacement.setTimeSeconds(this.#scatterTime);
      }
      if (this.#probeReplay !== undefined) {
        if (!replacement.setLightingProbes) throw new Forge3DError("UNSUPPORTED_FEATURE", "Recovery runtime does not support terrain probes");
        replacement.setLightingProbes(structuredClone(this.#probeReplay));
      }
      this.#terminalError = undefined;
      if (this.#initializationComplete) {
        this.#transition("ready");
        this.#controls?.resume();
        this.#scheduler?.resume();
        this.#scheduler?.requestRender();
        for (const listener of this.#recoveryListeners) {
          try {
            listener();
          } catch {
            // A recovery listener must not break the replay.
          }
        }
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
    this.#environmentReplay = undefined;
    this.#scatterReplay = undefined; this.#probeReplay = undefined;
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
  geometry?: TerrainGeometryInput;
  bounds?: [number, number, number, number];
  streaming?: TerrainStreamingInput;
  overlays?: TerrainOverlaysInput;
  material?: TerrainMaterialInput;
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
  if (source.geometry !== undefined) {
    const clipmap = source.geometry.clipmap;
    target.geometry = {
      ...(source.geometry.mode !== undefined
        ? { mode: source.geometry.mode }
        : {}),
      ...(clipmap !== undefined
        ? {
            clipmap: {
              ...clipmap,
              ...(clipmap.baseCellSize !== undefined
                ? {
                    baseCellSize: [
                      clipmap.baseCellSize[0],
                      clipmap.baseCellSize[1],
                    ],
                  }
                : {}),
            },
          }
        : {}),
    };
  }
  if (source.bounds !== undefined) {
    target.bounds = [
      source.bounds[0],
      source.bounds[1],
      source.bounds[2],
      source.bounds[3],
    ];
  }
  if (source.streaming !== undefined) {
    target.streaming = { ...source.streaming };
  }
  if (source.overlays !== undefined) {
    target.overlays = {
      ...source.overlays,
      ...(source.overlays.layers !== undefined
        ? {
            layers: source.overlays.layers.map((layer) => ({
              ...layer,
              image: {
                width: layer.image.width,
                height: layer.image.height,
                data: layer.image.data.slice(),
              },
              ...(layer.extent !== undefined
                ? { extent: [...layer.extent] as typeof layer.extent }
                : {}),
              ...(layer.crsBounds !== undefined
                ? {
                    crsBounds: [...layer.crsBounds] as typeof layer.crsBounds,
                  }
                : {}),
            })),
          }
        : {}),
    };
  }
  if (source.material !== undefined) {
    target.material = normalizeTerrainMaterial(source.material);
  }
}

function cloneVtSourceImage(image: MaterialVtSourceImage): MaterialVtSourceImage {
  return {
    width: image.width,
    height: image.height,
    data: image.data.slice(),
  };
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
