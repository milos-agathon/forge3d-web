/**
 * Compile-only consumer for the frozen FND-00 declarations.
 *
 * Executable viewer behavior is intentionally not claimed here. The emitted
 * facade staging test proves that Forge3DViewer and getCapabilities remain
 * unavailable until their owning FND-01..FND-07 implementation tasks land.
 */
import {
  BorrowedWasmView,
  createNotebookAdapter,
  defineForge3DElement,
  Forge3DError,
  Forge3DMessageClient,
  Forge3DOffscreenRenderer,
  Forge3DRuntime,
  Forge3DScene,
  Forge3DSession,
  Forge3DViewer,
  Forge3DWebSocketAdapter,
  Forge3DWorkerPool,
  Forge3DWorkerRenderer,
  getRendererPreset,
  installForge3DWorkerHost,
  readByteSource,
  RendererConfig,
  rendererPresetNames,
  selectWorkerExecutionMode,
  serveForge3DMessagePort,
  writeByteSink,
  type AdapterInfo,
  type BrowserByteSink,
  type BrowserByteSource,
  type ByteReadOptions,
  type ByteReadProgress,
  type ByteWriteResult,
  type CameraInput,
  type Forge3DDType,
  type Forge3DErrorCode,
  type Forge3DMessageCallOptions,
  type Forge3DMessageContext,
  type Forge3DMessageHandler,
  type Forge3DMessageHandlers,
  type Forge3DNotebookAdapter,
  type Forge3DOffscreenRendererOptions,
  type Forge3DRuntimeCapabilities,
  type Forge3DRuntimeOptions,
  type Forge3DSessionCapabilities,
  type Forge3DSessionOptions,
  type Forge3DTypedArray,
  type Forge3DViewerOptions,
  type Forge3DWorkerPoolOptions,
  type Forge3DWorkerRendererOptions,
  type MemoryCategory,
  type MemoryOverflowPolicy,
  type MemoryReport,
  type PassRenderStats,
  type QualityDowngrade,
  type OrbitControlsOptions,
  type OrbitView,
  type OffscreenOutput,
  type RendererConfigData,
  type RendererConfigInput,
  type RendererConfigSource,
  type RenderQuality,
  type RenderStats,
  type ResizeInput,
  type SceneNodeInput,
  type SceneNodeSnapshot,
  type ScenePassInput,
  type SceneRenderPlan,
  type SceneSnapshot,
  type SceneTransform,
  type SessionStatus,
  type TerrainColorRampInput,
  type TerrainHeightmapInput,
  type TerrainHeightmapSourceInput,
  type TerrainSourceProgress,
  type TransferableTypedArray,
  type TypedArrayShape,
  type ViewerCapabilities,
  type ViewerDiagnostics,
  type ViewerRecoveryOptions,
  type ViewerResizeOptions,
  type ViewerResourceBudget,
  type ViewerResourceOptions,
  type ViewerResourcePreset,
  type ViewerStatus,
  type ViewerStatusChange,
  type WorkerExecutionMode,
  type WorkerPoolDiagnostics,
  type WorkerRendererDiagnostics,
} from "../../types/index";

declare const offscreenCanvas: OffscreenCanvas;

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
  quality: "high",
  memoryBudgetBytes: 512 * 1024 * 1024,
  overflowPolicy: "downscale",
  timestampMode: "auto",
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

async function compileRuntimeDeclarations(): Promise<void> {
  const offscreenRuntime = await Forge3DRuntime.create(
    offscreenCanvas,
    options,
  );
  offscreenRuntime.dispose();

  const runtime = await Forge3DRuntime.create(canvas, options);
  const width: number = runtime.width;
  const height: number = runtime.height;
  const disposed: boolean = runtime.disposed;
  const diagnosticsEnabled: boolean = runtime.diagnosticsEnabled;
  const color: [number, number, number, number] = runtime.clearColor();
  const runtimeCapabilities: Forge3DRuntimeCapabilities =
    runtime.getCapabilities();
  const adapterInfo: AdapterInfo | undefined =
    runtimeCapabilities.adapterInfo;
  const surfaceFormats: string[] | undefined =
    runtimeCapabilities.surfaceFormats;
  const timestampQuery: boolean | undefined =
    runtimeCapabilities.timestampQuery;

  runtime.setTerrain(terrain);
  await runtime.setTerrainFromSource(sourceTerrain);
  runtime.setScene(Forge3DScene.create().snapshot());
  runtime.setCamera(camera);
  runtime.resize(resize);
  runtime.render();

  const runtimeStats: RenderStats = runtime.getRenderStats();
  const runtimeMemory: MemoryReport = runtime.getMemoryReport();
  const screenshot: Blob = await runtime.screenshot();
  const runtimeRgba: Uint8Array = await runtime.readRgba();
  runtime.dispose();

  void [
    width,
    height,
    disposed,
    diagnosticsEnabled,
    color,
    runtimeCapabilities,
    adapterInfo,
    surfaceFormats,
    timestampQuery,
    runtimeStats,
    runtimeMemory,
    screenshot,
    runtimeRgba,
  ];
}

async function compileViewerDeclarations(): Promise<void> {
  const viewer = await Forge3DViewer.create(canvas, viewerOptions);
  const status: ViewerStatus = viewer.status;
  const disposed: boolean = viewer.disposed;
  const view: OrbitView = viewer.getView();
  const capabilities: ViewerCapabilities = viewer.getCapabilities();
  const diagnostics: ViewerDiagnostics = viewer.getDiagnostics();
  const ownedAnimationFrameCount: number = diagnostics.ownedAnimationFrameCount;

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
    ownedAnimationFrameCount,
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

const rendererInput = {
  quality: "high",
  memoryBudgetBytes: 512 * 1024 * 1024,
  overflowPolicy: "downscale",
  timestampMode: "auto",
  sampleCount: 4,
  lighting: {
    exposure: 1.2,
    lights: [
      {
        type: "directional",
        intensity: 5,
        color: [1, 0.97, 0.92],
        direction: [-0.35, -1, -0.25],
      },
    ],
  },
  materials: {
    terrain: {
      id: "terrain-default",
      model: "pbr",
      parameters: { roughness: 0.6, flat: false, label: "terrain" },
    },
  },
  shading: {
    brdf: "cooktorrance-ggx",
    roughness: 0.5,
    metallic: 0,
    normalMaps: true,
  },
  shadows: { enabled: true, technique: "pcss", mapSize: 2048, cascades: 3 },
  gi: { modes: ["ibl"], ambientOcclusionStrength: 0.4 },
  atmosphere: { enabled: true, sky: "hosek-wilkie" },
  brdfOverride: "disney-principled",
} satisfies RendererConfigInput;

const configFromInput = new RendererConfig(rendererInput);
const configFromSource: RendererConfigSource = configFromInput;
const configFromPreset = getRendererPreset("rainier-showcase");
const presetNames: readonly string[] = rendererPresetNames();
const configData: RendererConfigData = configFromPreset.toJSON();
const configCopy = RendererConfig.from(configFromSource).copy({
  brdfOverride: null,
});
configCopy.validate();
const renderQuality: RenderQuality = configData.quality;
const overflowPolicy: MemoryOverflowPolicy = configData.overflowPolicy;

const groupNode = {
  kind: "group",
  name: "root",
} satisfies SceneNodeInput;

const terrainNode = {
  kind: "terrain",
  name: "terrain",
  terrain,
  transform: {
    translation: [0, 0, 0],
    rotation: [0, 0, 0, 1],
    scale: [1, 1, 1],
  } satisfies Partial<SceneTransform>,
} satisfies SceneNodeInput;

const groundPlaneNode = {
  kind: "ground-plane",
  name: "ground",
  size: [100, 100],
  color: [0.4, 0.5, 0.6, 1],
  height: 0,
} satisfies SceneNodeInput;

const textNode = {
  kind: "text-mesh",
  name: "label",
  text: "summit",
  size: 12,
  color: [1, 1, 1, 1],
} satisfies SceneNodeInput;

const overlayNode = {
  kind: "overlay",
  name: "hud",
  bounds: [0, 0, 200, 80],
  color: [0, 0, 0, 0.5],
  zIndex: 2,
} satisfies SceneNodeInput;

const customNode = {
  kind: "custom",
  name: "custom",
  layerType: "points",
  payload: { count: 3 },
} satisfies SceneNodeInput;

const scenePass = {
  name: "composite",
  kind: "render",
  reads: ["color"],
  writes: ["graded"],
  dependsOn: ["terrain"],
} satisfies ScenePassInput;

const sessionOptions = {
  runtime: viewerRuntimeOptions,
  renderer: configFromSource,
  recovery: { deviceLoss: "once" },
} satisfies Forge3DSessionOptions;

function compileSceneDeclarations(): void {
  const scene = Forge3DScene.create();
  const group = scene.addNode(groupNode);
  const terrainId = scene.addTerrain(terrain, { name: "terrain" });
  scene.setParent(terrainId, group);
  scene.addGroundPlane(groundPlaneNode);
  scene.addTextMesh(textNode);
  scene.addOverlay(overlayNode);
  scene.addNode(customNode);
  scene.addNode(terrainNode);
  scene.setTransform(group, { translation: [0, 0, 0] });
  scene.setVisible(group, true);
  scene.addPass(scenePass);
  scene.removePass("composite");
  const plan: SceneRenderPlan = scene.getRenderPlan();
  const snapshot: SceneSnapshot = scene.snapshot();
  const nodeSnapshot: SceneNodeSnapshot | undefined = scene.getNode(group);
  const nodes: SceneNodeSnapshot[] = scene.getNodes();
  const removed: number[] = scene.removeNode(terrainId);
  const estimate: number = scene.estimatedGpuBytes();
  const copied: Forge3DScene = scene.copy();
  const revision: number = scene.revision;
  const sceneDisposed: boolean = scene.disposed;
  copied.dispose();
  void [
    plan,
    snapshot,
    nodeSnapshot,
    nodes,
    removed,
    estimate,
    revision,
    sceneDisposed,
  ];
}

async function compileSessionDeclarations(): Promise<void> {
  const session = await Forge3DSession.create(offscreenCanvas, sessionOptions);
  const sessionStatus: SessionStatus = session.status;
  const sessionDisposed: boolean = session.disposed;
  const sessionConfig: RendererConfig = session.getConfig();
  const capabilities: Forge3DSessionCapabilities = session.getCapabilities();
  const adapterInfo: AdapterInfo = capabilities.adapterInfo;
  const timingMode: "gpu-timestamp" | "cpu" = capabilities.timingMode;
  const offscreenCanvasSupport: boolean = capabilities.offscreenCanvas;
  const workersSupport: boolean = capabilities.workers;
  const sharedArrayBufferSupport: boolean =
    capabilities.sharedArrayBuffer;
  const fileSystemAccessSupport: boolean = capabilities.fileSystemAccess;
  const opfsSupport: boolean = capabilities.opfs;
  const stats: RenderStats = session.getRenderStats();
  const passStats: PassRenderStats[] = stats.passes;
  const memory: MemoryReport = session.getMemoryReport();
  const categoryBytes: number = memory.categories[
    "buffers" satisfies MemoryCategory
  ];
  const downgrades: QualityDowngrade[] = memory.downgrades;

  const scene = Forge3DScene.create();
  session.setScene(scene);
  const currentScene: Forge3DScene | undefined = session.getScene();
  session.render();
  session.setCamera({
    position: [0, 0, 5],
    target: [0, 0, 0],
    up: [0, 1, 0],
    fovYDegrees: 45,
    near: 0.1,
    far: 100,
  });
  const rgba: Uint8Array = await session.readRgba();
  session.resize(resize);
  const sessionScreenshot: Blob = await session.screenshot();
  await session.whenReady();
  session.dispose();
  void rgba;

  void [
    sessionStatus,
    sessionDisposed,
    sessionConfig,
    adapterInfo,
    timingMode,
    offscreenCanvasSupport,
    workersSupport,
    sharedArrayBufferSupport,
    fileSystemAccessSupport,
    opfsSupport,
    passStats,
    categoryBytes,
    downgrades,
    currentScene,
    sessionScreenshot,
  ];
}

declare const messagePort: MessagePort;
declare const socket: WebSocket;
declare const container: HTMLElement;
declare const worker: Worker;

async function compileAdapterDeclarations(): Promise<void> {
  const dtype: Forge3DDType = "f32";
  const shape: TypedArrayShape = { dtype, shape: [2, 2] };
  const backing = new Float32Array(4);
  const view = new BorrowedWasmView(() => backing, shape);
  const viewDisposed: boolean = view.disposed;
  const generation: number = view.generation;
  const descriptor: TypedArrayShape = view.descriptor;
  const resolved: Float32Array = view.view();
  const owned: Float32Array = view.copy();
  const transferable: TransferableTypedArray<Float32Array> =
    view.transfer();
  view.dispose();

  const readOptions: ByteReadOptions = {
    signal: new AbortController().signal,
    maxBytes: 1024,
    onProgress: (progress: ByteReadProgress) => {
      void progress.loaded;
      void progress.done;
    },
  };
  const ownedBytes = new Uint8Array(owned);
  const sources: BrowserByteSource[] = [
    "https://example.test/data.bin",
    new URL("https://example.test/data.bin"),
    new Blob([ownedBytes]),
    new ArrayBuffer(4),
    ownedBytes,
    new ReadableStream<Uint8Array>(),
    new Response(ownedBytes),
  ];
  const bytes: Uint8Array = await readByteSource(sources[3]!, readOptions);

  const sinks: BrowserByteSink[] = [
    { kind: "blob", type: "application/octet-stream" },
    { kind: "stream", stream: new WritableStream<Uint8Array>() },
    { kind: "file-system", suggestedName: "out.bin" },
    { kind: "opfs", path: "forge3d/out.bin" },
    { kind: "download", filename: "out.bin" },
  ];
  const written: ByteWriteResult = await writeByteSink(
    bytes.slice(),
    sinks[0]!,
  );
  void written.bytesWritten;

  const echoHandler = ((payload: unknown, context: Forge3DMessageContext) => {
    void context.requestId;
    void context.signal;
    return payload;
  }) satisfies Forge3DMessageHandler;
  const messageHandlers: Forge3DMessageHandlers = {
    echo: echoHandler,
  };
  const unserve = serveForge3DMessagePort(messagePort, messageHandlers);
  const client = new Forge3DMessageClient(messagePort);
  const callOptions: Forge3DMessageCallOptions = {
    transfer: transferable.transfer,
  };
  const echoed = await client.call<unknown>("echo", null, callOptions);
  client.dispose();
  unserve();
  void echoed;

  const socketAdapter = new Forge3DWebSocketAdapter(socket);
  const adapterPort: MessagePort = socketAdapter.port;
  socketAdapter.dispose();
  void adapterPort;

  const mode: WorkerExecutionMode = selectWorkerExecutionMode({
    workerAvailable: true,
    crossOriginIsolated: true,
    sharedArrayBufferAvailable: true,
    preferSharedArrayBuffer: true,
  });
  const poolOptions: Forge3DWorkerPoolOptions = {
    size: 2,
    maxQueued: 8,
    preferSharedArrayBuffer: false,
    workerFactory: () => messagePort,
    mainThreadHandler: echoHandler,
  };
  const pool = new Forge3DWorkerPool(poolOptions);
  const pooled = await pool.run<number>(1);
  const poolDiagnostics: WorkerPoolDiagnostics = pool.getDiagnostics();
  pool.dispose();
  void [mode, pooled, poolDiagnostics];

  const rendererOptions: Forge3DWorkerRendererOptions = {
    worker,
    session: sessionOptions,
    controls,
    ariaLabel: "terrain",
  };
  const renderer = await Forge3DWorkerRenderer.create(
    canvas,
    rendererOptions,
  );
  await renderer.setScene(Forge3DScene.create());
  const submitted: boolean = await renderer.render();
  await renderer.resize(resize);
  const workerBlob: Blob = await renderer.screenshot();
  const workerRgba: Uint8Array = await renderer.readRgba();
  const workerDiagnostics: WorkerRendererDiagnostics =
    renderer.getDiagnostics();
  const activeObservers: number = workerDiagnostics.activeObservers;
  renderer.dispose();
  const unhost = installForge3DWorkerHost(worker);
  unhost();
  void [submitted, workerBlob, workerRgba, workerDiagnostics, activeObservers];

  const offscreenOptions: Forge3DOffscreenRendererOptions = {
    width: 64,
    height: 64,
    runtime: viewerRuntimeOptions,
  };
  const offscreen =
    await Forge3DOffscreenRenderer.create(offscreenOptions);
  offscreen.setScene(Forge3DScene.create());
  const offscreenRendered: boolean = offscreen.render();
  const output: OffscreenOutput = await offscreen.capture("blob");
  const sinkResult: ByteWriteResult = await offscreen.write(sinks[0]!);
  offscreen.dispose();
  void [offscreenRendered, output, sinkResult];

  const elementCtor: CustomElementConstructor = defineForge3DElement();
  void elementCtor;
  const adapter: Forge3DNotebookAdapter = createNotebookAdapter(
    container,
    sessionOptions,
  );
  const adapterCanvas: HTMLCanvasElement = adapter.canvas;
  const adapterSession: Promise<Forge3DSession> = adapter.session;
  await adapter.display(Forge3DScene.create());
  const adapterBlob: Blob = await adapter.capture();
  adapter.dispose();
  void [adapterCanvas, adapterSession, adapterBlob, resolved, viewDisposed, generation, descriptor];
}

void compileRuntimeDeclarations;
void compileViewerDeclarations;
void compileSceneDeclarations;
void compileSessionDeclarations;
void compileAdapterDeclarations;
void code;
void addedErrorCodes;
void allViewerStatuses;
void manuallyManagedViewerOptions;
void presetNames;
void renderQuality;
void overflowPolicy;

import {
  CascadedShadowConfig,
  decodeRgbe,
  extractGltfMaterialChannels,
  generateMeshTangents,
  getLightPreset,
  IblCache,
  ImageBasedLighting,
  Ktx2Loader,
  LightCollection,
  lightPresetNames,
  MaterialCollection,
  resolveBrdfModel,
  ShadowConfig,
  TextureSet,
  type BrdfRoute,
  type GltfMaterialChannels,
  type IblReport,
  type IblSnapshot,
  type LightBounds,
  type LightId,
  type LightingSnapshot,
  type LightInput,
  type LightPresetName,
  type MaterialCollectionSnapshot,
  type MeshTbnResult,
  type RgbeImage,
  type ShadowCascadeInfo,
  type ShadowFilter,
  type ShadowReport,
  type ShadowSnapshot,
  type TerrainRenderMode,
  type TextureImageSnapshot,
  type TextureSetSnapshot,
} from "../../types/index";

async function compileW04Declarations(): Promise<void> {
  const renderMode: TerrainRenderMode = "screen";
  const scene = Forge3DScene.create();
  scene.addTerrain({ ...terrain, renderMode });
  scene.clearLights();
  const sun = {
    type: "directional",
    color: [1, 1, 1],
    intensity: 2.4,
    direction: [0.65, -0.41, 0.65],
    castsShadow: true,
  } satisfies LightInput;
  const lightId: LightId = scene.addLight(sun);
  scene.updateLight(lightId, { ...sun, intensity: 2 });
  const bounds: LightBounds = scene.getLightBounds(lightId);
  const affects: boolean = scene.lightAffectsPoint(lightId, [0, 0, 0]);
  scene.setLightingExposure(1);
  scene.setLightDebugBounds(false);
  scene.setAreaLightApproximation({ mode: "sampled", sampleCount: 8 });
  const presetNames: readonly LightPresetName[] = lightPresetNames();
  const preset: LightInput = getLightPreset("candle");
  const lights = LightCollection.defaults();
  const lightingSnapshot: LightingSnapshot = lights.snapshot();

  scene.setMaterial("default", { id: "default", brdf: "hair", roughness: 0.5 });
  const route: BrdfRoute = resolveBrdfModel("blinn-phong");
  const materialRoute: BrdfRoute = scene.getMaterialRoute("default");
  const materials: MaterialCollectionSnapshot = new MaterialCollection().snapshot();

  const textures = new TextureSet({
    baseColor: {
      width: 1,
      height: 1,
      format: "rgba8unorm-srgb",
      colorSpace: "srgb",
      data: new Uint8Array(4),
    },
  });
  const textureSnapshot: TextureSetSnapshot = textures.snapshot();
  const tangents: MeshTbnResult = generateMeshTangents({
    positions: new Float32Array(9),
    normals: new Float32Array(9),
    uvs: new Float32Array(6),
    indices: new Uint32Array([0, 1, 2]),
  });
  const channels: GltfMaterialChannels = extractGltfMaterialChannels(new Uint8Array(4), 1, 1);
  const image: TextureImageSnapshot = await new Ktx2Loader().load(new Uint8Array(0), {
    semantic: "base-color",
    capabilities: { bc: false, etc2: false, astc: true },
  });

  const rgbe: RgbeImage = decodeRgbe(new Uint8Array(0));
  const ibl = await ImageBasedLighting.fromLinear(rgbe, { quality: "low" });
  const session = await Forge3DSession.create(offscreenCanvas, sessionOptions);
  const prepared = await ibl.prepare(session, new IblCache({ backend: "auto" }));
  const iblReport: IblReport = prepared.report;
  const iblSnapshot: IblSnapshot = await session.precomputeIbl(prepared.snapshot());
  scene.setImageBasedLighting(prepared);

  const filter: ShadowFilter = "pcss";
  scene.setShadows(new ShadowConfig({ filter }), new CascadedShadowConfig({ cascadeCount: 3 }));
  const cascades: ShadowCascadeInfo[] = scene.getShadowCascadeInfo(0.1, 100);
  session.setScene(scene);
  const shadowReport: ShadowReport = session.getShadowReport();
  const shadowSnapshot: ShadowSnapshot = scene.snapshot().shadows;

  const runtime = await Forge3DRuntime.create(canvas);
  runtime.setLighting(lightingSnapshot);
  runtime.setMaterials(materials);
  runtime.setIbl(null);
  runtime.setShadows(shadowSnapshot);
  const runtimeShadowReport: ShadowReport = runtime.getShadowReport();
  void [
    bounds,
    affects,
    presetNames,
    preset,
    route,
    materialRoute,
    textureSnapshot,
    tangents,
    channels,
    image,
    iblReport,
    iblSnapshot,
    cascades,
    shadowReport,
    runtimeShadowReport,
  ];
}

void compileW04Declarations;

import {
  Camera,
  CameraAnimation,
  CameraController,
  CameraKeyframe,
  composeTrs,
  DEFAULT_CAMERA_KEY_BINDINGS,
  depthOfFieldRange,
  FlyController,
  invertMatrix,
  lookAt,
  makeCamera,
  mat4ToRows,
  OrbitController,
  orthographic,
  perspective,
  RenderConfig,
  RenderProgress,
  replayCameraInput,
  screenRay,
  TERRAIN_CLEARANCE_TOLERANCE,
  TerrainClearance,
  TerrainOrbitRig,
  TerrainRailRig,
  TerrainRigSource,
  TerrainTargetFollowRig,
  terrainRigFromJSON,
  viewerOrbitRadius,
  worldToScreen,
  type CameraControllerMode,
  type CameraInputEvent,
  type CameraJSON,
  type CameraState,
  type ClipSpace,
  type FlyView,
  type ScreenPoint,
  type TerrainRig,
  type TerrainRigJSON,
  type Vec3,
} from "../../types/index";

async function compileW05Declarations(viewer: Forge3DViewer, session: Forge3DSession): Promise<void> {
  const clip: ClipSpace = "gl";
  const eye: Vec3 = [3, 4, 5];
  const view: Float32Array = lookAt(eye, [0, 0, 0], [0, 1, 0]);
  const projection: Float32Array = perspective(45, 1.5, 0.1, 100, clip);
  const ortho: Float32Array = orthographic(-1, 1, -1, 1, 0.1, 10);
  const rows: number[][] = mat4ToRows(composeTrs([1, 2, 3], [0, 90, 0], [1, 1, 1]));
  const camera = new Camera({ position: eye, target: [0, 0, 0], projection: "orthographic", orthographicHeight: 4 });
  const json: CameraJSON = camera.toJSON();
  const point: ScreenPoint | undefined = camera.worldToScreen([0, 0, 0], { width: 10, height: 10 });
  const projected = worldToScreen(camera.viewProjectionMatrix(1), [0, 0, 0], { width: 10, height: 10 });
  const ray = screenRay(invertMatrix(camera.viewProjectionMatrix(1)), 5, 5, { width: 10, height: 10 });
  const range = depthOfFieldRange(50, 2.8, 3000);
  const pathTracing = makeCamera({ origin: eye, lookAt: [0, 0, 0], up: [0, 1, 0], fovY: 40, aspect: 1, exposure: 1 });

  const animation = new CameraAnimation([new CameraKeyframe({ time: 0, phiDeg: 0, thetaDeg: 45, radius: 10, fovDeg: 50 })]);
  animation.addKeyframe({ time: 2, phiDeg: 90, thetaDeg: 40, radius: 12, fovDeg: 45, target: [0, 1, 0] });
  const state: CameraState | undefined = animation.evaluate(1);
  const frames: number = animation.getFrameCount(30);
  const naming = new RenderConfig({ fps: 24 }).framePath(3);
  const percent: number = new RenderProgress(1, 2, 0.5, naming).percent;

  const controller = new CameraController({ mode: "fly", bindings: { toggleMode: ["Tab"] } }, new OrbitController());
  const mode: CameraControllerMode = controller.toggleMode();
  const fly: FlyView = new FlyController().getView();
  const events: CameraInputEvent[] = [{ type: "key", code: DEFAULT_CAMERA_KEY_BINDINGS.forward[0] ?? "KeyW", pressed: true }];
  const replayed = replayCameraInput({}, events);

  const source = new TerrainRigSource({ heights: new Float32Array(4), width: 2, height: 2, terrainWidth: 10 });
  const rigs: TerrainRig[] = [
    new TerrainOrbitRig({ targetXZ: [5, 5], duration: 1, radius: 3, phiStartDeg: 0, phiEndDeg: 90, clearance: new TerrainClearance({ minimumHeight: 1 }) }),
    new TerrainRailRig({ pathXZ: [[1, 1], [9, 1]], duration: 1, cameraHeightOffset: 2, lookAheadDistance: 1 }),
    new TerrainTargetFollowRig({ targetPathXZ: [[2, 2], [8, 8]], duration: 1, radius: 1 }),
  ];
  const rigJson: TerrainRigJSON = rigs[0]!.toJSON();
  const baked: CameraAnimation = terrainRigFromJSON(rigJson).bake(source, { samplesPerSecond: 4 });
  const worldCamera = source.cameraAt(baked, 0.5, { near: 0.1, far: 100 });
  const radius: number = viewerOrbitRadius(source) + TERRAIN_CLEARANCE_TOLERANCE;

  viewer.setCameraMode("fly");
  viewer.setCamera({ ...replayed, projection: "orthographic", orthographicHeight: 5 });
  viewer.startCameraRecording();
  viewer.replayCameraInput(viewer.stopCameraRecording());
  const current = viewer.getCamera();
  const lastSessionCamera = session.getCamera();

  void [view, projection, ortho, rows, json, point, projected, ray, range, pathTracing, state, frames, percent, mode, fly, worldCamera, radius, current, lastSessionCamera];
}

void compileW05Declarations;
