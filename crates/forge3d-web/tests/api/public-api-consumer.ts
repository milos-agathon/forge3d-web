import {
  Forge3DError,
  Forge3DRuntime,
  Forge3DViewer,
  type CameraInput,
  type Forge3DErrorCode,
  type Forge3DRuntimeCapabilities,
  type Forge3DRuntimeOptions,
  type Forge3DViewerOptions,
  type OrbitControlsOptions,
  type OrbitView,
  type ResizeInput,
  type TerrainColorRampInput,
  type TerrainHeightmapInput,
  type TerrainHeightmapSourceInput,
  type TerrainSourceProgress,
  type ViewerCapabilities,
  type ViewerDiagnostics,
  type ViewerRecoveryOptions,
  type ViewerResizeOptions,
  type ViewerResourceBudget,
  type ViewerResourceOptions,
  type ViewerResourcePreset,
  type ViewerStatus,
  type ViewerStatusChange,
} from "../../types/index";

declare const canvas: HTMLCanvasElement;

const options = {
  powerPreference: "high-performance",
  width: 320,
  height: 180,
  devicePixelRatio: 2,
  clearColor: [0.1, 0.2, 0.3, 1.0],
  alphaMode: "premultiplied",
  colorSpace: "srgb",
  diagnostics: true,
} satisfies Forge3DRuntimeOptions;

const viewerRuntimeOptions = {
  powerPreference: "none",
  wasmUrl: new URL("./forge3d_web_bg.wasm", import.meta.url),
} satisfies Forge3DRuntimeOptions;

const initialView = {
  target: [0, 0, 0],
  distance: 2.72,
  yawDegrees: 0,
  pitchDegrees: 24,
  fovYDegrees: 46,
  near: 0.01,
  far: 100,
} satisfies OrbitView;

const controls = {
  enabled: true,
  keyboard: true,
  orbitSpeed: 1,
  panSpeed: 1,
  zoomSpeed: 1,
  minDistance: 0.01,
  maxDistance: 1_000_000,
  minPitchDegrees: -89,
  maxPitchDegrees: 89,
} satisfies OrbitControlsOptions;

const resizeOptions = {
  maxDevicePixelRatio: 2,
} satisfies ViewerResizeOptions;

const recovery = {
  deviceLoss: "once",
} satisfies ViewerRecoveryOptions;

const budget = {
  maxTerrainSamples: 1_048_576,
  maxSourceBytes: 4_194_304,
  maxCanvasPixels: 8_294_400,
  maxScreenshotPixels: 8_294_400,
} satisfies ViewerResourceBudget;

const preset = "desktop" satisfies ViewerResourcePreset;
const resources = {
  preset,
  budget: {
    maxTerrainSamples: budget.maxTerrainSamples,
  },
} satisfies ViewerResourceOptions;

const viewerOptions = {
  runtime: viewerRuntimeOptions,
  initialView,
  controls,
  resize: resizeOptions,
  recovery,
  resources,
  onStatusChange: (change: ViewerStatusChange) => {
    const previous: ViewerStatus = change.previous;
    const current: ViewerStatus = change.current;
    void [previous, current];
  },
  onError: (viewerError: Forge3DError) => {
    const viewerErrorCode: Forge3DErrorCode = viewerError.code;
    void viewerErrorCode;
  },
} satisfies Forge3DViewerOptions;

const manuallyManagedViewerOptions = {
  controls: false,
  resize: false,
  recovery: { deviceLoss: "none" },
  resources: {
    preset: "mobile",
    budget: {
      maxSourceBytes: 1_048_576,
      maxCanvasPixels: 2_073_600,
      maxScreenshotPixels: 2_073_600,
    },
  },
} satisfies Forge3DViewerOptions;

const terrain = {
  width: 2,
  height: 2,
  heights: new Float32Array([0, 1, 1, 0]),
  colorRamp: {
    stops: [
      { position: 0, color: [199 / 255, 208 / 255, 177 / 255] },
      { position: 0.5, color: [252 / 255, 232 / 255, 171 / 255] },
      { position: 1, color: [116 / 255, 94 / 255, 55 / 255] },
    ],
  } satisfies TerrainColorRampInput,
} satisfies TerrainHeightmapInput;

const sourceTerrain = {
  width: 2,
  height: 2,
  source: new ArrayBuffer(16),
  signal: new AbortController().signal,
  onProgress: (progress: TerrainSourceProgress) => {
    const loaded: number = progress.loaded;
    const total: number | undefined = progress.total;
    const done: boolean = progress.done;
    void [loaded, total, done];
  },
} satisfies TerrainHeightmapSourceInput;

const camera = {
  position: [1, 2, 3],
  target: [0, 0, 0],
  up: [0, 1, 0],
  fovYDegrees: 45,
  near: 0.1,
  far: 100,
} satisfies CameraInput;

const resize = {
  width: 640,
  height: 360,
  devicePixelRatio: 1.5,
} satisfies ResizeInput;

async function exercisePublicApi(): Promise<void> {
  const runtime = await Forge3DRuntime.create(canvas, options);
  const width: number = runtime.width;
  const height: number = runtime.height;
  const disposed: boolean = runtime.disposed;
  const diagnosticsEnabled: boolean = runtime.diagnosticsEnabled;
  const color: [number, number, number, number] = runtime.clearColor();
  const runtimeCapabilities: Forge3DRuntimeCapabilities =
    runtime.getCapabilities();

  runtime.setTerrain(terrain);
  await runtime.setTerrainFromSource(sourceTerrain);
  runtime.setCamera(camera);
  runtime.resize(resize);
  runtime.render();

  const screenshot: Blob = await runtime.screenshot();
  runtime.dispose();

  void [
    width,
    height,
    disposed,
    diagnosticsEnabled,
    color,
    runtimeCapabilities,
    screenshot,
  ];
}

async function exerciseViewerContract(): Promise<void> {
  const viewer = await Forge3DViewer.create(canvas, viewerOptions);
  const status: ViewerStatus = viewer.status;
  const disposed: boolean = viewer.disposed;
  const view: OrbitView = viewer.getView();
  const capabilities: ViewerCapabilities = viewer.getCapabilities();
  const diagnostics: ViewerDiagnostics = viewer.getDiagnostics();

  viewer.setTerrain(terrain);
  const firstSourceLoad: Promise<void> =
    viewer.setTerrainFromSource(sourceTerrain);
  const concurrentSourceLoad: Promise<void> =
    viewer.setTerrainFromSource(sourceTerrain);
  viewer.setView(initialView);
  viewer.resetView();
  viewer.resize(resize);
  viewer.render();
  const concurrentScreenshots: Promise<[Blob, Blob]> = Promise.all([
    viewer.screenshot(),
    viewer.screenshot(),
  ]);

  await Promise.allSettled([firstSourceLoad, concurrentSourceLoad]);
  const screenshots = await concurrentScreenshots;
  viewer.dispose();

  // The frozen contract keeps these getters and repeated disposal legal.
  const postDisposalStatus: ViewerStatus = viewer.status;
  const postDisposalDisposed: boolean = viewer.disposed;
  const postDisposalView: OrbitView = viewer.getView();
  const postDisposalCapabilities: ViewerCapabilities =
    viewer.getCapabilities();
  const postDisposalDiagnostics: ViewerDiagnostics = viewer.getDiagnostics();
  viewer.dispose();

  void [
    status,
    disposed,
    view,
    capabilities,
    diagnostics,
    screenshots,
    postDisposalStatus,
    postDisposalDisposed,
    postDisposalView,
    postDisposalCapabilities,
    postDisposalDiagnostics,
  ];
}

const error = new Forge3DError("INVALID_INPUT", "Invalid terrain input", {
  field: "heights",
});
const code: Forge3DErrorCode = Forge3DError.from(error).code;
const addedErrorCodes = [
  "INSECURE_CONTEXT",
  "WASM_LOAD_FAILED",
  "DEVICE_LOST",
  "INTERNAL_ERROR",
  "RESOURCE_LIMIT_EXCEEDED",
] satisfies Forge3DErrorCode[];

const allViewerStatuses = [
  "initializing",
  "ready",
  "recovering",
  "failed",
  "disposed",
] satisfies ViewerStatus[];

void exercisePublicApi;
void exerciseViewerContract;
void code;
void addedErrorCodes;
void allViewerStatuses;
void manuallyManagedViewerOptions;
