import {
  Forge3DError,
  Forge3DRuntime,
  type CameraInput,
  type Forge3DErrorCode,
  type Forge3DRuntimeOptions,
  type ResizeInput,
  type TerrainHeightmapInput,
  type TerrainHeightmapSourceInput,
  type TerrainSourceProgress
} from "../../src-ts/index";

declare const canvas: HTMLCanvasElement;

const options = {
  powerPreference: "high-performance",
  width: 320,
  height: 180,
  devicePixelRatio: 2,
  clearColor: [0.1, 0.2, 0.3, 1.0],
  alphaMode: "premultiplied",
  colorSpace: "srgb",
  diagnostics: true
} satisfies Forge3DRuntimeOptions;

const terrain = {
  width: 2,
  height: 2,
  heights: new Float32Array([0, 1, 1, 0])
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
  }
} satisfies TerrainHeightmapSourceInput;

const camera = {
  position: [1, 2, 3],
  target: [0, 0, 0],
  up: [0, 1, 0],
  fovYDegrees: 45,
  near: 0.1,
  far: 100
} satisfies CameraInput;

const resize = {
  width: 640,
  height: 360,
  devicePixelRatio: 1.5
} satisfies ResizeInput;

async function exercisePublicApi(): Promise<void> {
  const runtime = await Forge3DRuntime.create(canvas, options);
  const width: number = runtime.width;
  const height: number = runtime.height;
  const disposed: boolean = runtime.disposed;
  const diagnosticsEnabled: boolean = runtime.diagnosticsEnabled;
  const color: [number, number, number, number] = runtime.clearColor();

  runtime.setTerrain(terrain);
  await runtime.setTerrainFromSource(sourceTerrain);
  runtime.setCamera(camera);
  runtime.resize(resize);
  runtime.render();

  const screenshot: Blob = await runtime.screenshot();
  runtime.dispose();

  void [width, height, disposed, diagnosticsEnabled, color, screenshot];
}

const error = new Forge3DError("INVALID_INPUT", "Invalid terrain input", {
  field: "heights"
});
const code: Forge3DErrorCode = Forge3DError.from(error).code;

void exercisePublicApi;
void code;
