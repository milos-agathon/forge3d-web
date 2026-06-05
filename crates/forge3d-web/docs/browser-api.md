# Forge3D Browser API

This document freezes the Phase 11 browser API exposed by `@forge3d/web`.
Application code should import from the package entrypoint, not from wasm-pack
generated files under `pkg/`.

## Public API

```ts
import { Forge3DRuntime, Forge3DError } from "@forge3d/web";

const runtime = await Forge3DRuntime.create(canvas, {
  width: 640,
  height: 360,
  devicePixelRatio: window.devicePixelRatio,
  powerPreference: "high-performance",
  clearColor: [0.04, 0.06, 0.08, 1],
  alphaMode: "premultiplied",
  colorSpace: "srgb"
});

runtime.setTerrain({
  width: 2,
  height: 2,
  heights: new Float32Array([0, 1, 1, 0])
});

await runtime.setTerrainFromSource({
  width: 2,
  height: 2,
  source: new Blob([
    new Float32Array([0, 1, 1, 0]).buffer
  ], { type: "application/octet-stream" }),
  signal: new AbortController().signal,
  onProgress: ({ loaded, total, done }) => {
    console.log({ loaded, total, done });
  }
});

runtime.setCamera({
  position: [2, 2, 3],
  target: [0, 0, 0],
  up: [0, 1, 0],
  fovYDegrees: 45,
  near: 0.1,
  far: 100
});

runtime.resize({
  width: 800,
  height: 450,
  devicePixelRatio: window.devicePixelRatio
});

runtime.render();
const pngBlob = await runtime.screenshot();
runtime.dispose();
```

The stable MVP surface is:

- `Forge3DRuntime.create(canvas, options): Promise<Forge3DRuntime>`
- `runtime.setTerrain(terrain): void`
- `runtime.setTerrainFromSource(terrain): Promise<void>`
- `runtime.setCamera(camera): void`
- `runtime.resize(size): void`
- `runtime.render(): void`
- `runtime.screenshot(): Promise<Blob>`
- `runtime.dispose(): void`
- `runtime.disposed`, `runtime.width`, `runtime.height`, and `runtime.diagnosticsEnabled`
- `runtime.clearColor(): [number, number, number, number]`
- `Forge3DError` with stable `code`, `message`, and optional `details`

## Lifetime Rules

`Forge3DRuntime.create(canvas, options)` initializes browser WebGPU resources
asynchronously and binds the runtime to that canvas. Call `dispose()` when the
canvas or owning view is no longer used.

After `dispose()`, the runtime keeps `disposed === true`. Calls that require GPU
resources, including `setTerrain(terrain)`, `setCamera(camera)`, `resize(size)`,
`render()`, and `screenshot()`, throw or reject with `Forge3DError` code
`RUNTIME_DISPOSED`.

Typed-array inputs are copied into runtime-owned WebGPU resources. Callers may
reuse or release the original `Float32Array` after `setTerrain(terrain)` returns.
Byte-source terrain inputs are asynchronously read before the same terrain
validation and GPU upload path is used.

## Browser IO

`runtime.setTerrainFromSource(terrain)` accepts little-endian f32 heightmap bytes
from these browser-native sources:

- URL string or `URL` object read through `fetch`
- `Blob`
- `File`
- `ArrayBuffer`

The source must contain exactly `width * height` f32 values unless
`byteOffset`/`byteLength` selects that byte range. URL range requests map
`byteOffset`/`byteLength` to a `Range` header; servers may ignore or reject
range headers, in which case failures are surfaced through the stable error
codes below. `signal` accepts an `AbortSignal`; aborted reads reject with
`REQUEST_CANCELLED`. Browser fetch, CORS, body-read, Blob slicing, and range
failures reject with `IO_ERROR` unless the request was aborted.

## Error Codes

The facade normalizes generated wasm and browser errors into these stable codes:

- `WEBGPU_UNAVAILABLE`
- `WEBGPU_ADAPTER_UNAVAILABLE`
- `DEVICE_REQUEST_FAILED`
- `SURFACE_CREATE_FAILED`
- `SURFACE_LOST`
- `SURFACE_OUTDATED`
- `OUT_OF_MEMORY`
- `UNSUPPORTED_FEATURE`
- `INVALID_INPUT`
- `IO_ERROR`
- `REQUEST_CANCELLED`
- `SHADER_COMPILATION_FAILED`
- `RUNTIME_DISPOSED`

Invalid dimensions, non-finite camera values, unsupported runtime options,
wrong typed-array lengths, and invalid byte ranges use `INVALID_INPUT`. Browser
IO uses `IO_ERROR` for fetch/CORS/body/range failures and `REQUEST_CANCELLED`
for aborted source reads.
