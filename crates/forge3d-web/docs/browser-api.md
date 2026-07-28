# Forge3D Browser API

This document freezes the FND-00 browser API exposed by `@forge3d/web`.
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
  colorSpace: "srgb",
});

runtime.setTerrain({
  width: 2,
  height: 2,
  heights: new Float32Array([0, 1, 1, 0]),
  colorRamp: {
    stops: [
      { position: 0, color: [199 / 255, 208 / 255, 177 / 255] },
      { position: 0.5, color: [252 / 255, 232 / 255, 171 / 255] },
      { position: 1, color: [116 / 255, 94 / 255, 55 / 255] },
    ],
  },
});

await runtime.setTerrainFromSource({
  width: 2,
  height: 2,
  source: new Blob([new Float32Array([0, 1, 1, 0]).buffer], {
    type: "application/octet-stream",
  }),
  signal: new AbortController().signal,
  onProgress: ({ loaded, total, done }) => {
    console.log({ loaded, total, done });
  },
});

runtime.setCamera({
  position: [2, 2, 3],
  target: [0, 0, 0],
  up: [0, 1, 0],
  fovYDegrees: 45,
  near: 0.1,
  far: 100,
});

runtime.resize({
  width: 800,
  height: 450,
  devicePixelRatio: window.devicePixelRatio,
});

runtime.render();
const pngBlob = await runtime.screenshot();
runtime.dispose();
```

`Forge3DRuntime` remains the low-level immediate-render primitive. Its stable
surface is:

- `Forge3DRuntime.create(canvas, options): Promise<Forge3DRuntime>`
- `runtime.getCapabilities(): Forge3DRuntimeCapabilities`
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

The high-level interactive surface is frozen as:

- `Forge3DViewer.create(canvas, options): Promise<Forge3DViewer>`
- `viewer.status`, `viewer.disposed`, `viewer.getView()`,
  `viewer.getCapabilities()`, and `viewer.getDiagnostics()`
- `viewer.setTerrain(terrain)` and `viewer.setTerrainFromSource(terrain)`
- `viewer.setView(view)` and `viewer.resetView()`
- `viewer.resize(size)`, `viewer.render()`, and `viewer.screenshot()`
- `viewer.dispose()`

`Forge3DRuntimeOptions.powerPreference` accepts `"none"`, `"low-power"`, or
`"high-performance"`. Omission still means `"high-performance"` for direct
low-level runtime consumers. When the viewer caller omits it, the viewer passes
the internal value `"none"`. `Forge3DRuntimeOptions.wasmUrl` accepts a string or
`URL`; it is owned and removed by the TypeScript facade before Rust option
deserialization.

## Frozen Viewer Defaults

| Area | Default |
|---|---|
| View | Y-up; target `[0, 0, 0]`, distance `2.72`, yaw `0`, pitch `24`, FOV `46`, near `0.01`, far `100` |
| Controls | Enabled; keyboard enabled; orbit, pan, and zoom speeds `1`; distance `[0.01, 1_000_000]`; pitch `[-89, 89]` degrees |
| Resize | Automatic `ResizeObserver`; the selected resource preset supplies maximum DPR |
| Recovery | One unexpected device recreation (`deviceLoss: "once"`) |
| Resources | `desktop` preset |

`controls: false` attaches no input listeners. `resize: false` disables
automatic observation but leaves explicit `resize()` available.

Resource presets and their effective defaults are:

| Preset | Terrain samples | Source bytes | Canvas pixels | Screenshot pixels | Maximum DPR |
|---|---:|---:|---:|---:|---:|
| `desktop` | 1,048,576 | 4,194,304 | 8,294,400 | 8,294,400 | 2 |
| `mobile` | 262,144 | 1,048,576 | 2,073,600 | 2,073,600 | 2 |

`resources.budget` partially overrides the selected preset after each supplied
value passes finite-positive-integer validation.

## Interaction And Automatic Redraw

The orbit controller is Y-up. Mouse left-drag orbits; middle- or right-drag
pans; wheel and trackpad input zoom. One touch or pen pointer orbits. Two
pointers pan and pinch-zoom. While the canvas has focus, the keyboard can orbit,
pan, zoom, and reset. Low-level `Forge3DRuntime.setCamera()` continues to accept
arbitrary camera values and is not constrained to orbit-camera input.

`Forge3DViewer.render()` marks the viewer dirty and schedules at most one
animation frame; it does not submit synchronously. `setTerrain()`, a successfully
resolved `setTerrainFromSource()`, `setView()`, `resetView()`, and `resize()`
also mark the viewer dirty. The viewer does not run a continuous rendering loop
while idle. `Forge3DRuntime.render()` remains immediate.

## Viewer Lifecycle And Recovery

Successful creation reports `initializing -> ready` before the create promise
resolves. Failed creation reports `initializing -> failed`, calls `onError`
once, then rejects. `onStatusChange` fires once per actual transition.
`onError` receives each normalized terminal or recovery-triggering error once;
a skipped surface frame is not an error. Exceptions thrown by callbacks are
caught and reported asynchronously without corrupting viewer state.

Unexpected device loss defaults to one recovery attempt. During `recovering`,
controls and scheduling are suspended; operational calls throw or reject
`DEVICE_LOST`, while getters and `dispose()` remain legal. The active terrain
source load is cancelled with `REQUEST_CANCELLED`, and only the last committed
terrain is replayed. `recovery.deviceLoss: "none"` reports `DEVICE_LOST` and
enters `failed`. Surface recovery belongs to the low-level runtime and does not
consume the device-recovery allowance.

In `failed`, `status`, `disposed`, all three getters, and `dispose()` remain
legal. Operational methods throw or reject the retained terminal
`Forge3DError`. Disposal transitions `failed -> disposed`.

The facade loads `wasmUrl`, which defaults to
`new URL("./forge3d_web_bg.wasm", import.meta.url)`, as a successful
`application/wasm` response. A versioned coordinator under a stable
`Symbol.for` key on the current Window realm's `globalThis` makes the first
in-flight canonical URL a singleton across duplicate facade bundles. Same-URL
callers join the promise; a different URL rejects with `INVALID_INPUT`; success
fixes that URL for the realm; and an owning failure releases it for retry.

## Concurrency And Cleanup

The viewer permits one active terrain source load. A concurrent second call
rejects with `INVALID_INPUT`; the first remains cancellable through its
`AbortSignal`. A successful load becomes the replay descriptor and schedules a
frame.

Concurrent screenshot calls share one underlying capture and resolve to the
same `Blob`; they do not allocate a second GPU readback. The capture uses the
current committed terrain, camera, and size even when presentation is still
scheduled.

`dispose()` is synchronous and idempotent. It cancels the pending animation
frame, removes owned input and lifecycle listeners, disconnects observers,
invalidates recovery, disposes the owned runtime, and releases screenshot/load
state. Final diagnostics expose `ownedListeners`, `activeObservers`,
`pendingAnimationFrame`, and `activeRuntimes`, allowing cleanup to be verified.

After disposal, `disposed`, `status`, `getView()`, `getCapabilities()`,
`getDiagnostics()`, and repeated `dispose()` remain legal and return defensive
snapshots where applicable. Setters, `resize()`, `render()`, `screenshot()`, and
source loading throw or reject `RUNTIME_DISPOSED`.

Renderer behavior is capability-driven. No public option selects a browser
name, browser engine, or user-agent-derived mode.

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

`setTerrain(terrain)` accepts an optional `colorRamp` with 2-8 ordered stops.
Stop positions and RGB channels use normalized `0..1` values.

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
- `INSECURE_CONTEXT`
- `WASM_LOAD_FAILED`
- `DEVICE_REQUEST_FAILED`
- `DEVICE_LOST`
- `SURFACE_CREATE_FAILED`
- `SURFACE_LOST`
- `SURFACE_OUTDATED`
- `OUT_OF_MEMORY`
- `UNSUPPORTED_FEATURE`
- `INVALID_INPUT`
- `IO_ERROR`
- `REQUEST_CANCELLED`
- `SHADER_COMPILATION_FAILED`
- `INTERNAL_ERROR`
- `RESOURCE_LIMIT_EXCEEDED`
- `RUNTIME_DISPOSED`

Invalid dimensions, non-finite camera values, unsupported runtime options,
wrong typed-array lengths, and invalid byte ranges use `INVALID_INPUT`. Browser
IO uses `IO_ERROR` for fetch/CORS/body/range failures and `REQUEST_CANCELLED`
for aborted source reads.
