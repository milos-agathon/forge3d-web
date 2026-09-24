# Forge3D Browser API

This document defines the browser API exposed by `@forge3d/web`.
Application code should import from the package entrypoint, not from wasm-pack
generated files under `pkg/`.

The shared FND-01..FND-07 implementation exports the interactive viewer,
recoverable low-level runtime, deterministic input controls, bounded resource
policy, and engine-neutral test harness. Browser-family support remains subject
to its own branded and physical release evidence; code completion alone is not
a platform support claim.

## Public API

```ts
import {
  Forge3DRuntime,
  Forge3DViewer,
  Forge3DError,
} from "@forge3d/web";

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

const viewer = await Forge3DViewer.create(canvas, {
  resources: { preset: "desktop" },
  recovery: { deviceLoss: "once" },
});
viewer.setTerrain({
  width: 2,
  height: 2,
  heights: new Float32Array([0, 1, 1, 0]),
});
viewer.render(); // invalidates; the viewer submits at most one frame per RAF
viewer.dispose();
```

`Forge3DRuntime` remains the low-level immediate-render primitive. Its stable
surface is:

- `Forge3DRuntime.create(canvas, options): Promise<Forge3DRuntime>`
- `runtime.setTerrain(terrain): void`
- `runtime.setTerrainFromSource(terrain): Promise<void>`
- `runtime.setCamera(camera): void`
- `runtime.resize(size): void`
- `runtime.render(): boolean` (`true` only when commands were submitted and
  presented; `false` for a timeout/occluded surface)
- `runtime.screenshot(): Promise<Blob>`
- `runtime.readTerrainHeights(): Promise<Float32Array>`
- `runtime.computeTerrainAnalysis(terrain, request): Promise<TerrainComputeResult>`
- `runtime.readTerrainAnalysis(kind): Promise<TerrainScalarField>`
- `runtime.dispose(): void`
- `runtime.disposed`, `runtime.width`, `runtime.height`, and `runtime.diagnosticsEnabled`
- `runtime.clearColor(): [number, number, number, number]`
- `runtime.getCapabilities(): Forge3DRuntimeCapabilities`
- `Forge3DError` with stable `code`, `message`, and optional `details`

## Interactive Viewer API

The emitted facade implements the frozen high-level surface:

- `runtime.getCapabilities(): Forge3DRuntimeCapabilities`
- `Forge3DViewer.create(canvas, options): Promise<Forge3DViewer>`
- `viewer.status`, `viewer.disposed`, `viewer.getView()`,
  `viewer.getCapabilities()`, and `viewer.getDiagnostics()`
- `viewer.setTerrain(terrain)` and `viewer.setTerrainFromSource(terrain)`
- `viewer.setView(view)` and `viewer.resetView()`
- `viewer.resize(size)`, `viewer.render()`, and `viewer.screenshot()`
- `viewer.dispose()`

`Forge3DRuntimeOptions.powerPreference` accepts `"none"`, `"low-power"`, or
`"high-performance"`. Omission still means `"high-performance"` for direct
low-level runtime consumers, and Rust now accepts the explicit `"none"` value.
The viewer passes internal value `"none"` when its caller omits the
option.

`Forge3DRuntimeOptions.wasmUrl` accepts a string or `URL`. The facade fetches
and validates the asset before wasm-bindgen initialization; it is stripped from
the Rust options boundary and can never fail as an unknown Rust field.

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
pan, zoom, and reset: arrows orbit, Shift+arrows pan, `+`/`-` zoom, and Home
resets. Low-level `Forge3DRuntime.setCamera()` continues to accept arbitrary
camera values and is not constrained to orbit-camera input.

Pressing `KeyV` (configurable through `controls.bindings.toggleMode`)
switches between orbit and fly (FPS) control without moving the view. In fly
mode, dragging looks around, `W`/`S` or Up/Down move along the view direction,
`A`/`D` or Left/Right strafe, `E`/`Q` rise and descend, Shift doubles the
speed, and Home resets the fly view. Held movement keys keep the viewer's single
owned animation frame alive and stop it when released, blurred, suspended, or
disposed; one frame never applies more than 0.1 s of movement.

`Forge3DViewer.render()` marks the viewer dirty and schedules at most one
animation frame; it does not submit synchronously. `setTerrain()`, a successfully
resolved `setTerrainFromSource()`, `setView()`, `resetView()`, and `resize()`
also mark the viewer dirty. The viewer does not run a continuous rendering loop
while idle. `Forge3DRuntime.render()` remains immediate.

### Visibility And Occlusion

When `document.visibilityState` becomes `hidden`, the viewer cancels its
pending animation-frame callback but keeps the same canvas, scheduler,
listeners, observer, and WebGPU runtime. Returning to `visible` coalesces the
dirty state into exactly one attempted frame. A visible but occluded surface
may make `Forge3DRuntime.render()` return `false`; the viewer records that
attempt as a skipped frame and remains ready for the next invalidation.

Neither a hidden document nor an occluded/skipped frame emits
`REQUEST_CANCELLED`, starts device recovery, or recreates the runtime.
`REQUEST_CANCELLED` remains reserved for cancelled terrain-source work,
including work cancelled during an actual device-loss recovery.

The shared 30-cycle source-browser and installed-package lifecycle exercise is
hermetic by default: it uses an explicitly labelled deterministic synthetic
`document.visibilityState` override. With `FORGE3D_HEADED=1`, Chromium projects
instead use a second real browser tab and require actual
`document.visibilityState` transitions. The Playwright Firefox and WebKit
preflights use the explicitly labelled synthetic mode because those automated
engine lanes do not yield real background-tab visibility. This does not
describe branded or physical Firefox or shipping Safari. The lifecycle record
states whether actual document transitions occurred and always marks itself as
non-promotional. Synthetic proof establishes
source/package behavior only; even a headed result must be incorporated into the separately attested branded, physical browser
and GPU matrix before it can contribute to a support claim.

The physical SAF-03 lane is distinct. It drives shipping Safari with the exact
Selenium 4.35.0 client and Apple's SafariDriver, records every native action
with camera/frame/decoded-pixel before-and-after evidence, and runs separate
30-cycle real-tab visibility and persisted-true BFCache sequences. A separately
labelled persisted-false refresh proves cold initialization is not counted as a
restore. The versioned proof retains native and viewer screenshot digests plus
the complete raw FND-07 benchmark and is revalidated across each evidence
boundary. Safari Technology Preview is an optional, separately inventoried
probe and never substitutes for shipping Safari.

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

The facade loads `wasmUrl`, defaulting to
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
`pendingAnimationFrame`, `ownedAnimationFrameCount`, and `activeRuntimes`,
allowing cleanup and the single viewer-owned RAF invariant to be verified.

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
Stop positions and RGB channels use normalized `0..1` values. The named
`colormap` input (`"viridis"`, `"magma"`, `"terrain"`, or `"grayscale"`) is
normalized to explicit stops by the facade before crossing the WASM boundary;
supplying `colormap` and `colorRamp` together is `INVALID_INPUT`.

## Terrain Datasets (W03)

`TerrainDataset` is a typed DEM container with validated metadata and CPU
analysis. Heights are little-endian f32 elevation samples in row-major order
(row 0 is z-min; rows increase toward north/+z). `spacing` is the physical
cell size in meters
(default `[1, 1]`), `exaggeration` scales rendered height above the domain
minimum (default `1`), and `domain` is the valid `[min, max]` elevation range
used for normalization and color mapping (default: observed valid minimum and
maximum). `nodata` marks invalid samples; `NaN` and the numeric marker are
excluded from statistics while positive and negative infinity are
`INVALID_INPUT`. `crs`, `transform`, and `bounds` are retained metadata.

```ts
import { TerrainDataset } from "@forge3d/web";

const dataset = TerrainDataset.fromArray({
  width: 257,
  height: 257,
  heights,
  spacing: [30, 30],
  nodata: -9999,
  crs: "EPSG:32633",
  colormap: "terrain",
});

const fromBytes = await TerrainDataset.fromSource({
  width: 257,
  height: 257,
  source: fileOrBlobOrArrayBufferOrUrl,
  signal: controller.signal,
  onProgress: ({ loaded, total, done }) => {},
  maxBytes: 64 * 1024 * 1024,
});
```

- `TerrainDataset.fromArray(input)` retains the input `Float32Array`
  (`dataset.heights === input.heights`) and performs no second full-sized
  allocation.
- `TerrainDataset.fromSource(input, { workerPool })` decodes exact
  little-endian f32 bytes from a `string`/`URL` (fetched), `File`, `Blob`, or
  `ArrayBuffer`. Wrong byte counts reject
  with `IO_ERROR`, cancellation with `REQUEST_CANCELLED`, `maxBytes` overflow
  with `RESOURCE_LIMIT_EXCEEDED`, and invalid metadata or source types with
  `INVALID_INPUT`. With a `Forge3DWorkerPool` the owned byte buffer is
  transferred into the worker and back without an extra clone;
  `createTerrainDatasetWorkerHandler()` serves that payload.
- `dataset.statistics` reports `min`, `max`, `mean`, population `std`,
  `median`, `p01`, `p99`, valid `count`, and `nodataCount` over valid samples.
- `dataset.validMask()`, `dataset.normalize(options)`, and
  `dataset.fillNodata("nearest" | "mean")` never mutate the source; the
  derived calls return new datasets. `nearest` fill is deterministic nearest
  Euclidean valid cell with row-major tie-breaking.
- `dataset.slopeAspect()` returns per-cell slope and downslope aspect in
  radians (x = east, grid row = north, aspect clockwise from north in
  `[0, 2π)`, flat cells `0`; invalid cells `NaN`). Central differences are
  used in the interior and one-sided differences at boundaries, in physical
  spacing units.
- `dataset.contours(levels)` runs marching squares in physical centered
  coordinates and returns deterministic segment polylines.
- `dataset.query(x, z)` bilinearly interpolates elevation in physical world
  coordinates and reports `slopeRadians`, `aspectRadians`, `worldPosition`,
  `normal`, and `gridPosition`; outside the extent it returns `undefined`.
- `dataset.heightAo(options)` and `dataset.sunVisibility(options)` return
  scalar fields mirroring the GPU formulas (nearest height sampling over
  `spacing * dimensions` world extent). AO averages
  `1 - clamp(atan(maxTangent) / (π/2))` over evenly spaced directions then
  applies `mix(1, ao, strength)`; sun marches toward the sun direction in
  `hard` or `soft` mode. Invalid output cells are `NaN`.
- `dataset.estimatedCpuBytes()` counts owned f32 bytes plus a materialized
  mask if present.
- `getTerrainColormap(name)` returns the named control stops and
  `getTerrainColormapLut(input, size = 256)` returns an RGBA8 lookup table.

`dataset.toTerrainInput()` converts a dataset into a `TerrainHeightmapInput`
for `setTerrain`/`computeTerrainAnalysis`. `TerrainHeightmapInput` additionally
accepts `spacing`, `exaggeration`, `domain`, `nodata`, `crs`, `heightAo`,
`sunVisibility`, and `debugView` (`"none"`, `"height-ao"`, or
`"sun-visibility"`). Enabled AO and sun visibility run WebGPU compute passes
that modulate terrain shading; a `debugView` renders the resident field as
grayscale. Disabled passes bind a constant `1.0` fallback.

`runtime.readTerrainHeights()` copies the resident R32Float height texture
back to a `Float32Array`, reproducing source scalars including `NaN` nodata.
`runtime.computeTerrainAnalysis(terrain, request)` dispatches WebGPU compute
for `{ kind: "slope-aspect" }`, `{ kind: "height-ao", options }`, and
`{ kind: "sun-visibility", options }` and resolves to the discriminated
`TerrainComputeResult`. `runtime.readTerrainAnalysis("height-ao" |
"sun-visibility")` reads the resident analysis texture and rejects with
`UNSUPPORTED_FEATURE` when that pass was not enabled on the committed
terrain. All three obey the same disposal and readback-serialization rules
as screenshots.

## Lights, Materials, Textures, IBL, And Shadows

W04 adds typed lighting, material, texture, image-based-lighting, and shadow
state to `Forge3DScene`. Every selection is validated in TypeScript and again
by the runtime, and every report states the *effective* choice, never only
the requested one.

```ts
import {
  Forge3DScene,
  ImageBasedLighting,
  IblCache,
  resolveBrdfModel,
} from "@forge3d/web";

const scene = Forge3DScene.create();
scene.addTerrain({ ...terrain, renderMode: "screen" });
scene.clearLights(); // every scene starts with a default key + fill light
scene.addLight({ type: "directional", color: [1, 1, 1], intensity: 2.4, direction: [0.65, -0.41, 0.65] });
scene.setMaterial("default", { id: "default", brdf: "cooktorrance-ggx", roughness: 0.52 });
const ibl = await ImageBasedLighting.fromRGBE(hdrBytes, { quality: "medium" });
scene.setImageBasedLighting(await ibl.prepare(session, new IblCache()));
scene.setShadows({ enabled: true, filter: "pcss", mapSize: 2048 }, { enabled: true, cascadeCount: 3 });
session.setScene(scene);
```

- **Lights.** `addLight`/`updateLight`/`removeLight`/`clearLights` manage up
  to 64 `directional`, `point`, `spot`, and `rect` lights (`LightCollection`
  exposes the same API standalone). Point and spot lights take a soft
  `innerRadius`, `edgeSoftness`, and `falloff` (`linear`, `quadratic`,
  `cubic`, `exponential`). `getLightBounds(id)` and
  `lightAffectsPoint(id, point)` report the effective range. Rect lights use
  LTC by default; `setAreaLightApproximation({ mode: "sampled", sampleCount })`
  selects the sampled approximation. `getLightPreset(name)` returns the
  `spotlight`, `area-light`, `ambient-light`, `candle`, and `street-lamp`
  presets.
- **Materials and BRDF routing.** `setMaterial(slot, input)` accepts all 13
  native BRDF models. `resolveBrdfModel(name)` and `getMaterialRoute(slot)`
  report the observable route: `blinn-phong` is an `alias` of `phong`;
  `subsurface` (→ `disney-principled`) and `hair` (→ `ashikhmin-shirley`) are
  `approximation`s with a `diagnostic`. Every other model is `exact`. Unknown
  model names reject with `INVALID_INPUT`.
- **Textures.** `TextureSet` holds base-color, normal, metallic-roughness,
  occlusion, and emissive images with explicit `colorSpace`, mip levels, and
  sampler state. `generateMeshTangents(input)` returns per-vertex `xyzw`
  tangents: per-triangle accumulation, Gram–Schmidt orthogonalization against
  the normal, and handedness in `w`. `extractGltfMaterialChannels(rgba, w, h)`
  splits a glTF ORM texture into occlusion (R), roughness (G), and
  metallic (B).
  `Ktx2Loader.load(source, { semantic, capabilities })` parses KTX2 with
  `ktx-parse`. Natively compressed BC/ETC2/ASTC payloads upload only when the
  matching `capabilities` flag is set. Otherwise the load rejects; it is never
  silently decompressed. Basis Universal payloads transcode through the
  configured `basisTranscoder` in `astc` → `bc7` → `etc2` → RGBA8 order. The resulting
  image records `effectiveQuality` (`native`, `transcoded`, or
  `rgba8-fallback`). An unsupported container rejects with
  `UNSUPPORTED_FEATURE`, and `getLastReport()` still describes the attempt
  with `effectiveQuality: "unsupported"`.
- **IBL.** `ImageBasedLighting.fromRGBE(bytes, options)` decodes Radiance
  RGBE in-repo. Irradiance, the specular prefilter, and the split-sum GGX BRDF
  LUT are computed on the GPU. `ibl.prepare(session, cache)` stores the
  precomputed maps in an `IblCache` keyed by source hash and settings. The
  `auto` backend chooses CacheStorage, then OPFS, then `none`. `ibl.report`
  records `effectiveMode` (`runtime-precompute` or `prepared-upload`),
  `cacheBackend`, and `cacheHit`.
- **Shadows.** Shadows are off until `enabled: true`. `ShadowConfig` selects one filter: `hard`, `pcf`, `pcss`,
  `vsm`, `evsm`, or `msm`. Cascades are a separate pipeline configured by
  `CascadedShadowConfig` (2–4 cascades, split lambda, blend range,
  stabilization). The filter parser rejects `"csm"` with `INVALID_INPUT`:
  "csm is a cascade pipeline, not a shadow filter". The map size is admitted
  against the memory budget. `getShadowReport()` returns the requested and
  effective filter and map size, the effective cascade state (`csmEnabled` is
  `false` and `cascadeCount` is `1` while shadows are disabled), the moment
  format, the caster light id, and a `reason` (`requested configuration`,
  `memory budget`, `shadows disabled`, or
  `no shadow-casting directional light`).
- **Atomic commits.** `session.setScene(scene)` validates and admits lighting,
  materials, IBL, and shadows together. A rejected commit leaves the
  previously committed frame, memory report, and shadow report unchanged, and
  device-loss recovery replays the last accepted scene.

`renderMode: "screen"` on a terrain reproduces the historical native
`terrain_pbr_pom` screen path: a fullscreen triangle, nearest-texel height
sampling, stylized hillshade composition, and a filmic tonemap. In this mode
the shadow pass uses the native fixed orthographic light matrix and the native
depth-caster packing. The native caster collapses when the height-domain
minimum is `0`, so such scenes are unshadowed, exactly as in native. The
general P07 filter/CSM path serves `renderMode: "perspective"` (the default).

## Cameras, Controllers, Animation, And Rigs

W05 ports the native camera surface (C01-C04). Every numeric path is checked
against `tests/golden/w05-camera-native.json`, recorded from the native
Forge3D oracle, within 1e-5 (relative above magnitude 1).

- **Cameras and projections.** `CameraInput` accepts `projection:
  "orthographic"` with a required `orthographicHeight` (vertical world extent;
  width follows the viewport aspect). The runtime, session, viewer, shadows and
  lighting all honour it, and device-loss recovery replays it. The immutable
  `Camera` class adds `viewMatrix()`, `projectionMatrix(aspect, clipSpace)`,
  `worldToScreen`, `screenToWorld`, `screenRay` and versioned JSON. Free
  functions `lookAt`, `perspective`, `orthographic` and `viewProjection` take a
  `clipSpace` of `"wgpu"` (depth `0..1`, default) or `"gl"` (`-1..1`) like the
  native `camera_*` functions. Matrices are column-major `Float32Array(16)`;
  `mat4ToRows`/`mat4FromRows` convert to the native row-major layout.
  `translate`, `rotateX/Y/Z`, `scale`, `scaleUniform`, `composeTrs`
  (`T * R * S`, Euler X then Y then Z), `lookAtTransform`, `multiplyMatrices`,
  `invertMatrix` and `normalMatrix` port the native transforms. Screen space is
  pixels from the top-left corner with WebGPU NDC depth. Depth-of-field
  helpers (`depthOfFieldRange`, `hyperfocalDistance`, `circleOfConfusion`,
  `fStopToAperture`, `cameraDofParams`) and `makeCamera` match native.
  Validation keeps the native wording but names the browser parameters, for
  example "fovYDegrees must be finite and in (0, 180)".
- **Controllers.** `OrbitController` keeps the frozen viewer orbit behaviour.
  `FlyController` is the native FPS camera: `update(dt, input)` moves
  `moveSpeed` (default 5) units per second along forward/right/up with a boost
  multiplier (default 2). `CameraController` combines both, switches modes
  continuously, resolves `KeyboardEvent.code` bindings (defaults above; the
  native Tab binding is available but not the default because it would trap
  keyboard focus), and expresses every change as a serializable
  `CameraInputEvent`. `startRecording()`/`stopRecording()` capture events and
  `replayCameraInput(options, events)` reproduces the camera bit-for-bit. The
  viewer exposes `getCameraMode()`, `setCameraMode()`, `getFlyView()`,
  `setFlyView()`, `getCamera()`, `setCamera()` (Y-up cameras only),
  `startCameraRecording()`, `stopCameraRecording()` and
  `replayCameraInput()`; `resetView()` resets the active controller.
- **Keyframe animation.** `CameraAnimation` stores target-aware
  `CameraKeyframe`s (azimuth `phiDeg`, polar `thetaDeg` from +Y, `radius`,
  `fovDeg`, optional `target`) sorted by time and interpolates them with the
  native Catmull-Rom (cubic Hermite) basis in f32. `evaluate(time)` clamps to
  the keyframe range, `getFrameCount(fps)` is `ceil(duration * fps) + 1`, and
  `cameraAt(time)` returns a renderer `CameraInput` (eye
  `target + r (sin θ cos φ, cos θ, sin θ sin φ)`). `RenderConfig` names frame
  sequences (`frame_0042.png`) and `ensureOutputDir()` creates the directory
  below a File System Access or OPFS handle; `RenderProgress.percent` reports
  completion. Animations serialize with `toJSON()`/`CameraAnimation.fromJSON()`.
- **Terrain rigs.** `TerrainOrbitRig`, `TerrainRailRig` and
  `TerrainTargetFollowRig` bake deterministic, clearance-verified animations
  from a `TerrainRigSource` (the native contract: terrain spans
  `[0, terrainWidth]`, heights rebased to the minimum and scaled by `zScale`).
  After the initial bake at `samplesPerSecond`, the path is verified at
  `max(32 * samplesPerSecond, 240)` Hz and refined for up to
  `clearance.maxRefinePasses` passes; a path whose eye would still dip below
  terrain + `minimumHeight` or leave the terrain is rejected with
  `INVALID_INPUT`. Baked keyframes match native; because Catmull-Rom can
  still dip between verification samples, rig playback through
  `rig.cameraAt(source, animation, time)` or `source.eyeAt(animation, time,
  { minimumHeight })` lifts the eye to terrain + `minimumHeight`, so played-back
  cameras never violate the minimum at any time.
  `TerrainRigSource.fromDataset(dataset)` samples a W03 `TerrainDataset` and
  `source.cameraAt(animation, time)` maps rig space onto the renderer's world
  space. Rigs serialize with `toJSON()`/`terrainRigFromJSON()`.

## Readback, AOVs, Offline Quality, Frames, And Video

W06 ports native readback and offline output (R02, C05-C08). Captures never
touch the display frame: they render the committed scene through dedicated
capture pipelines into float targets and read them back with padded rows
decoded in WASM.

- **Frames.** `Frame` is tight RGBA8 (rows top to bottom), `HdrFrame` is
  linear float RGBA and `AovFrame` carries linear `albedo()` RGB, world-space
  shading `normal()` XYZ, `depth()` (linear view depth normalized by the camera
  clip planes, background `1`; `linearDepth()` converts back), object `id()`
  (`0` background, `AOV_ID_TERRAIN`, scene nodes `aovObjectId(node)`) and pixel
  `motion()` (`current - previous`, +x right, +y down, from `previousCamera`).
  Missing channels throw `INVALID_INPUT` with the native wording ("Normal AOV
  not available"). `Frame.toPng()` is deterministic (`compression: "none"` is
  byte-identical everywhere).
- **Capture.** `runtime.capture(options)` / `session.capture(options)` returns
  `{ frame, hdrFrame, aovFrame }`; `aovs` defaults to the native albedo,
  normal and depth (`"all"` adds ID and motion). HDR color is unclamped scene
  radiance with overlays composited premultiplied; the default `display`
  tonemap reproduces the realtime frame within one unit per channel.
- **Offline accumulation.** `beginOfflineAccumulation({ samples, seed, aovs,
  previousCamera })`, `accumulateBatch(n)`, `readAccumulationMetrics(targetVariance,
  tileSize)`, `resolveOfflineHdr({ tonemap, denoise })` and
  `endOfflineAccumulation()` follow the native session: jitter is the native
  R2 sequence (seeded), metrics are native relative tile-luminance deltas
  against the last three readings, a second begin fails with "already active",
  and metrics before any sample fail. While a session is open `render()`
  returns `false`, `screenshot()`/`readRgba()` reject, and scene/camera
  mutations queue until it ends. `renderOffline(target, options)` (also a
  runtime/session method) ports `render_offline`: `settings.enabled` must be
  true, adaptive runs stop after `minSamples` on an upward convergence trend,
  `onProgress` receives `OfflineProgress`, `signal` cancels with
  `REQUEST_CANCELLED`, and the session always ends. Depth, ID and motion come
  from one unjittered reference pass. A device loss surfaces `DEVICE_LOST`.
- **Denoise.** `DenoiseSettings` validates like native (`atrous`, `oidn`,
  `none`; 1-10 iterations). The WebGPU A-trous denoiser uses the native
  B3-spline weights with albedo, normal-angle and optional depth guides plus a
  luminance edge-stopping term (`edgeStopping`, default 1) scaled by a robust
  noise estimate, so converged frames stay unchanged; `edgeStopping: 0`
  reproduces the native NumPy weights. `oidn` is unavailable in browsers and
  falls back to A-trous with the native warning in `metadata.warnings`.
  `runtime.denoiseHdrFrame(hdr, aov)` denoises any frame on the GPU and
  `atrousDenoise(input)` is the CPU/WASM reference; `compareImages` reports
  MSE, PSNR (native definition) and SSIM.
- **Tonemap.** `display` plus the native `reinhard`, `reinhard-extended`,
  `aces`, `uncharted2`, `exposure` and `filmic-terrain` operators run on the
  GPU in `resolveOfflineHdr` and on the CPU in `HdrFrame.tonemap()`.
- **EXR.** `HdrFrame.toExr()`, `AovFrame.toExr(beauty)` and `writeExr()`
  produce `image/x-exr` `Blob`s with native channel names (`beauty.R/G/B/A`,
  `albedo.R/G/B`, `normal.X/Y/Z`, `depth.Z`, `id` as uint, `motion.X/Y`),
  optional text metadata and `none`/`rle`/`zip`/`zips`/`piz` compression.
  `readExr()` validates the header before decoding, so malformed files fail
  with `INVALID_INPUT` and oversized ones with `RESOURCE_LIMIT_EXCEEDED`.
- **Frame sequences.** `renderFrames(target, { animation | cameraAt, fps,
  mode })` yields frames at exact times `i / fps` with microsecond timestamps
  `round(i * 1e6 / fps)`; `mode` is `capture` (default), `display` or
  `offline`. `createFrameStream` wraps it as a `ReadableStream`. `writeFrames`
  drains into a sink: `createMemoryFrameSink`, `createOpfsFrameSink` (below a
  `RenderConfig.outputDir` in OPFS or a File System Access directory) or
  `createDownloadFrameSink`; names follow `RenderConfig.frameFileName`.
  `FrameDumper` and `dumpFrameSequence` port the native dumper.
- **Video.** `encodeVideo(frames, { fps, container, codec })` encodes with
  WebCodecs (`avc`, `vp9`, `av1`, `hevc`, `vp8`, first supported wins) and
  muxes MP4 or WebM with the lock-pinned mediabunny 1.58.0; frame `i` has
  timestamp `round(i * 1e6 / fps)` and muxing is deterministic (the MP4
  creation time is pinned). When no codec can encode, the error is
  `UNSUPPORTED_FEATURE` with `VideoCodecUnavailableDetails`
  (`kind: "video-codec-unavailable"` plus per-codec probes);
  `probeVideoCodecs` reports support up front and `muxEncodedVideo` muxes
  caller-encoded chunks.

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
