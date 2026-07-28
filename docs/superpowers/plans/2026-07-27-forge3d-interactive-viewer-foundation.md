# Forge3D Interactive Viewer Shared Foundation Plan

Date: 2026-07-27
Depends on: current browser MVP at `ffba491`
Consumed by: Chromium/Edge, Safari, Firefox, and mobile plans

## Goal

Add a browser-engine-neutral interactive viewer on top of
`Forge3DRuntime`, then harden the Rust/WASM runtime so that normal browser
lifecycle events and failures are observable and recoverable.

This plan is deliberately browser-neutral. Browser-specific work must not fork
camera math, gestures, resource ownership, error semantics, or lifecycle rules.

## Frozen Public Contract

Keep `Forge3DRuntime` as the low-level, immediate render primitive and add the
following high-level contract. FND-00 must put this declaration into the API
snapshot before FND-01..07 begin. Later tasks may implement it but may not add
public members implicitly.

```ts
export type ViewerStatus =
  | "initializing"
  | "ready"
  | "recovering"
  | "failed"
  | "disposed";

// Forge3DErrorCode also gains:
// "INSECURE_CONTEXT" | "WASM_LOAD_FAILED" | "DEVICE_LOST" |
// "INTERNAL_ERROR" | "RESOURCE_LIMIT_EXCEEDED"
//
// Forge3DRuntimeOptions.powerPreference becomes:
// "none" | "low-power" | "high-performance"
// Forge3DRuntimeOptions also gains:
// wasmUrl?: string | URL

export type ViewerResourcePreset = "desktop" | "mobile";

export interface OrbitView {
  target: [number, number, number];
  distance: number;
  yawDegrees: number;
  pitchDegrees: number;
  fovYDegrees: number;
  near: number;
  far: number;
}

export interface OrbitControlsOptions {
  enabled?: boolean;
  keyboard?: boolean;
  orbitSpeed?: number;
  panSpeed?: number;
  zoomSpeed?: number;
  minDistance?: number;
  maxDistance?: number;
  minPitchDegrees?: number;
  maxPitchDegrees?: number;
}

export interface ViewerResizeOptions {
  maxDevicePixelRatio?: number;
}

export interface ViewerRecoveryOptions {
  deviceLoss?: "none" | "once";
}

export interface ViewerResourceBudget {
  maxTerrainSamples: number;
  maxSourceBytes: number;
  maxCanvasPixels: number;
  maxScreenshotPixels: number;
}

export interface ViewerResourceOptions {
  preset?: ViewerResourcePreset;
  budget?: Partial<ViewerResourceBudget>;
}

export interface Forge3DRuntimeCapabilities {
  deviceState: "ready" | "lost" | "disposed";
  maxTextureDimension2D: number;
  maxBufferSize: number;
  surfaceFormat: string;
}

export interface ViewerCapabilities extends Forge3DRuntimeCapabilities {
  secureContext: true;
  webgpuAvailable: true;
}

export interface ViewerDiagnostics {
  generation: number;
  renderRequests: number;
  submittedFrames: number;
  skippedFrames: number;
  activePointers: number;
  ownedListeners: number;
  activeObservers: number;
  activeRuntimes: number;
  pendingAnimationFrame: boolean;
  recoveryAttempts: number;
  screenshotInFlight: boolean;
  effectiveResourceBudget: ViewerResourceBudget;
  effectiveMaxDevicePixelRatio: number;
}

export interface ViewerStatusChange {
  previous: ViewerStatus;
  current: ViewerStatus;
}

export interface Forge3DViewerOptions {
  runtime?: Forge3DRuntimeOptions;
  initialView?: OrbitView;
  controls?: false | OrbitControlsOptions;
  resize?: false | ViewerResizeOptions;
  recovery?: ViewerRecoveryOptions;
  resources?: ViewerResourceOptions;
  onStatusChange?: (change: ViewerStatusChange) => void;
  onError?: (error: Forge3DError) => void;
}

export declare class Forge3DViewer {
  static create(
    canvas: HTMLCanvasElement,
    options?: Forge3DViewerOptions,
  ): Promise<Forge3DViewer>;
  readonly disposed: boolean;
  readonly status: ViewerStatus;
  getView(): OrbitView;
  getCapabilities(): ViewerCapabilities;
  getDiagnostics(): ViewerDiagnostics;
  setTerrain(terrain: TerrainHeightmapInput): void;
  setTerrainFromSource(terrain: TerrainHeightmapSourceInput): Promise<void>;
  setView(view: OrbitView): void;
  resetView(): void;
  resize(size: ResizeInput): void;
  render(): void;
  screenshot(): Promise<Blob>;
  dispose(): void;
}

// Forge3DRuntime additionally gains:
// getCapabilities(): Forge3DRuntimeCapabilities
```

The contract has these exact semantics and defaults:

| Area | Frozen behavior |
|---|---|
| Rendering | `Forge3DViewer.render()` marks the viewer dirty and schedules at most one RAF; it does not submit synchronously. `setTerrain`, a successfully resolved `setTerrainFromSource`, `setView`, `resetView`, and `resize` automatically do the same. `Forge3DRuntime.render()` remains immediate. |
| Initial view | Y-up; target `[0, 0, 0]`, distance `2.72`, yaw `0`, pitch `24`, FOV `46`, near `0.01`, far `100`. |
| Controls | Enabled with keyboard by default. Speeds default to `1`. Distance defaults to `[0.01, 1_000_000]`; pitch defaults to `[-89, 89]` degrees. `controls: false` attaches no input listeners. |
| Resize | Automatic `ResizeObserver` ownership is enabled by default. `resize: false` disables it; explicit `resize()` still works. Default maximum DPR is supplied by the selected resource preset. |
| Resources | `resources.preset` defaults to `desktop`: 1,048,576 terrain samples, 4,194,304 source bytes, 8,294,400 canvas pixels, 8,294,400 screenshot pixels, and DPR 2. `mobile` uses 262,144 samples, 1,048,576 source bytes, 2,073,600 canvas/screenshot pixels, and DPR 2. `resources.budget` partially overrides the selected preset after finite-positive-integer validation. |
| Power preference | Omitted `Forge3DRuntimeOptions.powerPreference` continues to mean `high-performance` for direct low-level consumers. The viewer explicitly passes internal value `none` when its caller omits the option. Public low-level options add `"none"` without changing the existing omitted default. |
| Recovery | Device-loss recovery defaults to `"once"`. While `recovering`, controls/scheduling are suspended and operational calls throw or reject `DEVICE_LOST`; getters and `dispose()` remain legal. An active terrain source load is cancelled with `REQUEST_CANCELLED`, and only the last committed terrain is replayed. `"none"` reports `DEVICE_LOST` and transitions to `failed`. Surface recovery is owned by the low-level runtime and does not consume the device-recovery allowance. |
| Terrain source concurrency | Only one viewer-owned source load may be active. A second call rejects with `INVALID_INPUT`; the caller may cancel the first through its `AbortSignal`. A successful load becomes the replay descriptor and schedules a frame. |
| Screenshot concurrency | A screenshot captures the current committed terrain/camera/size state even if presentation is still scheduled. Concurrent calls share one underlying capture and resolve to the same `Blob`; no second GPU readback is allocated. |
| Callbacks | Successful creation fires `initializing -> ready` before the promise resolves. Failed creation fires `initializing -> failed`, calls `onError`, then rejects. `onStatusChange` otherwise fires once per actual transition. `onError` receives each normalized terminal or recovery-triggering error once; skipped surface frames are not errors. Exceptions thrown by either callback are caught and reported asynchronously without corrupting viewer state. |
| Failed state | `status`, `disposed`, all three getters, and `dispose()` remain legal. Every operational method throws or rejects the retained terminal `Forge3DError` until disposal; `dispose()` transitions `failed -> disposed`. |
| Disposal | `dispose()` is synchronous and idempotent. After disposal, `disposed`, `status`, `getView()`, `getCapabilities()`, `getDiagnostics()`, and repeated `dispose()` remain legal. All setters, `resize`, `render`, `screenshot`, and source loading throw or reject `RUNTIME_DISPOSED`. Getters return defensive snapshots. |
| WASM asset | `Forge3DRuntimeOptions.wasmUrl` defaults to `new URL("./forge3d_web_bg.wasm", import.meta.url)` and the viewer forwards `options.runtime.wasmUrl`. The TypeScript facade strips this facade-only field before calling Rust, fetches the URL, requires a successful response whose parsed media type is `application/wasm`, and passes the validated `Response` to wasm-bindgen initialization. A versioned coordinator stored under a stable `Symbol.for` key on the current Window realm's `globalThis` makes the first in-flight canonical URL singleton across duplicate facade bundles in that realm; same-URL callers join its one promise, a different URL rejects with `INVALID_INPUT` even while initialization is pending, success fixes that URL for the realm, and owning failure releases the reservation for retry. |

`Forge3DViewer` retains only the state required for interaction and one
device-loss replay. The existing `Forge3DRuntime` API remains source-compatible.

## FND-00 — Freeze Interaction And Lifecycle Semantics

**Priority:** P0

**Task definition**

Commit the exact contract and defaults above before implementing DOM listeners,
runtime recovery, resource policy, or browser projects. No downstream task may
invent another public type or lifecycle rule.

**Necessary code changes**

- Add every type and member in the frozen contract to
  `crates/forge3d-web/types/index.d.ts`, including capabilities, diagnostics,
  resource preset/budget, callbacks, and legal post-disposal getters.
- Freeze the five added error codes, explicit low-level
  `powerPreference: "none"` value, and facade-only `wasmUrl` option in the same
  declaration/API snapshot change.
- Freeze `Forge3DRuntimeCapabilities` and the low-level
  `Forge3DRuntime.getCapabilities()` member. Device-event registration between
  the generated WASM object and high-level viewer remains private and is not an
  additional public API.
- Mirror the interfaces in `crates/forge3d-web/src-ts/index.ts`, or re-export
  them from new implementation modules.
- Add the exact declarations to
  `crates/forge3d-web/tests/api/index.d.ts.snapshot` and compile representative
  usage in `crates/forge3d-web/tests/api/public-api-consumer.ts`.
- Extend `crates/forge3d-web/docs/browser-api.md` with the defaults table,
  automatic redraw rules, screenshot/source concurrency, lifecycle ownership,
  recovery semantics, and cleanup guarantees.
- State that the orbit controller is Y-up. Continue to permit arbitrary camera
  values through low-level `Forge3DRuntime.setCamera()`.

**Definition of done**

- The API snapshot fails on any unreviewed viewer contract change.
- Documentation and declarations agree on every default and gesture.
- Low-level runtime consumers compile unchanged.
- Tests cover every automatic invalidation, concurrency, callback, getter, and
  post-disposal rule in the frozen table.
- No public option accepts a browser name or user-agent-derived mode.
- FND-01..07 introduce no public type or member absent from this task.

## FND-01 — Make Runtime Initialization And Rendering Recoverable

**Priority:** P0

**Task definition**

Replace failures that currently panic, escape normalization, or terminate an
interaction loop with stable runtime state and actionable errors.

**Necessary code changes**

- Split the 1,386-line `crates/forge3d-web/src/runtime.rs` into focused modules:
  `runtime/mod.rs`, `runtime/init.rs`, `runtime/render.rs`,
  `runtime/terrain.rs`, `runtime/readback.rs`, and
  `runtime/device_health.rs`. Preserve `crate::runtime::Forge3DRuntime`.
- In `crates/forge3d-core/src/gpu/runtime.rs`, register
  `wgpu::Device::set_device_lost_callback` and
  `wgpu::Device::on_uncaptured_error`; expose shared device health without a
  process-global singleton.
- Check that shared health state at the start of every GPU-touching runtime
  method so the first interaction after an idle-period loss returns
  `DEVICE_LOST` and starts viewer recovery.
- Add a generated-WASM internal device-event registration hook. The TypeScript
  facade attaches one private listener per runtime generation and forwards a
  device-loss event to `Forge3DViewer`; the hook is omitted from the stable
  TypeScript declarations and detached during disposal.
- Add stable error codes in Rust, TypeScript, declarations, API snapshots, and
  docs:
  `INSECURE_CONTEXT`, `WASM_LOAD_FAILED`, `DEVICE_LOST`, and `INTERNAL_ERROR`.
  Add `RESOURCE_LIMIT_EXCEEDED` for a request rejected before allocation.
  Keep surface loss separate from device loss.
- Change the TypeScript unknown-code/unknown-value fallback from
  `WEBGPU_UNAVAILABLE` to `INTERNAL_ERROR`; only confirmed missing WebGPU may use
  `WEBGPU_UNAVAILABLE`.
- Move `loadWasmBridge()` inside the TypeScript facade's normalization boundary.
  Resolve the default WASM URL with
  `new URL("./forge3d_web_bg.wasm", import.meta.url)`, or use the frozen
  `wasmUrl` override; fetch it explicitly, require an HTTP success and parsed
  media type `application/wasm`, then pass the validated `Response` to
  wasm-bindgen initialization. Map import, fetch, MIME, and instantiation
  failures to `WASM_LOAD_FAILED`.
- Remove `wasmUrl` from the object passed into the Rust
  `RuntimeOptions` deserializer, which intentionally keeps
  `deny_unknown_fields`.
- Canonicalize the singleton key exactly once with
  `new URL(wasmUrl ?? "./forge3d_web_bg.wasm", import.meta.url)`, clear its
  fragment because fragments are not sent by `fetch`, and use the resulting
  `.href`; preserve the query because it can select a different asset.
- Define the stable slot key exactly as
  `Symbol.for("@forge3d/web.wasm-bridge-coordinator")`. Store one non-enumerable,
  non-configurable coordinator object on the current Window realm's
  `globalThis`:
  `{ schemaVersion: 1, record?: { selectedUrl: string, promise:
  Promise<WasmBridge>, state: "pending" | "ready" } }`. Multiple resolved
  facade-module/package copies in the same Window realm must obtain this same
  coordinator. Never use a module-level fallback or per-URL map. If the slot
  exists with an unknown schema/version/shape, reject `INTERNAL_ERROR` without
  importing, fetching, overwriting, or creating a second coordinator.
- Canonicalize the requested URL before consulting `coordinator.record` and
  apply this state machine:
  - with no record, construct the initialization promise and install a
    `pending` record before any `await` or fetch continuation can yield;
  - a caller for the same canonical URL returns the identical promise in both
    `pending` and `ready` states;
  - a caller for a different canonical URL rejects with `INVALID_INPUT` in both
    states and performs no import, fetch, or initialization work;
  - successful initialization changes only `state` to `ready`, retaining the
    same URL and promise;
  - rejection clears the record only when the rejecting promise is still the
    record's promise. This ownership comparison prevents a stale rejection from
    deleting a newer retry. The coordinator object itself remains installed;
    successful disposal does not clear a ready WASM bridge.
- Check `globalThis.isSecureContext` before `navigator.gpu` and report
  `INSECURE_CONTEXT` when appropriate.
- Refactor `TerrainRenderResources` into format-independent terrain
  buffers/bindings and a surface-format-dependent pipeline. Create and validate
  the shader, bind-group layout, and initial pipeline during async runtime
  initialization. Use a WebGPU/wgpu validation error scope so
  `SHADER_COMPILATION_FAILED` is reachable rather than nominal.
- Implement the wgpu 29 surface states literally:
  - `Outdated`: call `Surface::configure()` on the existing surface and retry
    acquisition once;
  - `Lost`: drop the lost surface, recreate it from the retained
    `HtmlCanvasElement` through the retained `Instance`, query capabilities
    again, choose/configure a new descriptor, rebuild the terrain pipeline if
    the surface format changed, and retry acquisition once;
  - `Timeout` and `Occluded`: return a non-error skipped-frame result;
  - `Validation`: surface the captured validation failure.
  A failed surface recreation returns `SURFACE_LOST`; it does not masquerade as
  device loss or consume the viewer's device-recovery allowance.
- Implement frozen `Forge3DRuntime.getCapabilities()` with device state,
  `maxTextureDimension2D`, `maxBufferSize`, and configured surface format.
  Do not expose high-entropy adapter identity as a required public contract.
- Replace source-string assertions in `crates/forge3d-web/src/lib.rs` with
  behavior or module contract tests so file splitting does not weaken tests.

**Definition of done**

- A shader validation failure is returned as `SHADER_COMPILATION_FAILED` with
  the shader/pipeline label.
- An intentionally rejected WASM URL or incorrect WASM MIME response is returned
  as `WASM_LOAD_FAILED`.
- Two concurrent calls for the same canonical WASM URL receive the same promise
  and cause exactly one fetch/import/initialization.
- A duplicate-module fixture loads two physically distinct bundled copies of the
  facade into one Window `globalThis`; same-URL calls share one promise/fetch,
  and different-URL calls reject without a second fetch. A separate Window
  realm has its own coordinator, which is the documented realm boundary.
- While that promise is pending, a call with a different canonical URL rejects
  `INVALID_INPUT` without issuing a second fetch. The same rejection applies
  after the first URL reaches `ready`.
- After an owning WASM fetch/initialization failure, correcting the same route or
  choosing another URL permits a later `create()` to retry. A targeted race test
  proves that a stale rejected promise cannot clear a newer record.
- An incompatible object preinstalled at the stable symbol produces
  `INTERNAL_ERROR` and remains untouched; no duplicate bundle can silently
  downgrade or replace the coordinator.
- Insecure non-loopback HTTP is distinguished from absent WebGPU.
- `Outdated` reconfigures the existing surface; `Lost` creates a distinct
  surface. Both retry at most once.
- A test-induced format change on surface recreation rebuilds the
  format-dependent pipeline before the next draw; terrain buffers are not
  unnecessarily re-uploaded.
- Occlusion or a temporary acquisition timeout does not emit a request
  cancellation error.
- A device-loss signal reaches the TypeScript viewer exactly once.
- Disposing a low-level runtime detaches its private event listener;
  `getCapabilities()` remains legal and returns `deviceState: "disposed"`.
- Existing render, terrain, resize, source, screenshot, and disposal tests stay
  green.
- Surface handling has a contract test against wgpu 29 semantics and cites
  <https://docs.rs/wgpu/29.0.3/wgpu/enum.CurrentSurfaceTexture.html>.

## FND-02 — Implement Deterministic Orbit Camera Math

**Priority:** P0

**Task definition**

Create a pure TypeScript orbit controller that converts input deltas to complete
`CameraInput` values. Keep math independent from the DOM so every browser uses
the same clamps and tests.

**Necessary code changes**

- Add `crates/forge3d-web/src-ts/orbit-controller.ts`.
- Store target, distance, yaw, pitch, FOV, and clip planes as the canonical
  state. Derive position from spherical coordinates; do not incrementally mutate
  the previous position vector.
- Clamp pitch away from the poles, clamp distance to configured min/max, and
  reject non-finite inputs before calling WASM.
- Scale pan by distance and viewport height so drag sensitivity remains stable
  across DPR and canvas size.
- Make zoom exponential so wheel and pinch input cannot cross zero.
- Add Vitest as a pinned development dependency, commit the lockfile update,
  add `"test:unit": "vitest run"` to
  `crates/forge3d-web/package.json`, and put pure tests under
  `crates/forge3d-web/tests/unit/`.
- Add unit tests for orbit, pan, zoom, reset, clamps, finite output, and
  round-trip `OrbitView` state.

**Definition of done**

- Repeating the same delta sequence produces bitwise-identical JavaScript camera
  values across test runs.
- Ten thousand randomized finite input deltas produce no NaN, infinity, zero
  distance, or invalid clip planes.
- Pitch, distance, and FOV cannot escape documented bounds.
- Pan sensitivity is based on CSS pixels and is therefore DPR-independent.
- The controller has no imports from `window`, `document`, or a browser engine.
- `npm run test:unit` exists, runs in a clean `npm ci` checkout, and executes the
  controller tests without launching a browser.

## FND-03 — Implement Pointer, Touch, Wheel, And Keyboard Controls

**Priority:** P0

**Task definition**

Translate standard DOM input into the pure orbit controller and make listener
ownership deterministic.

**Necessary code changes**

- Add `crates/forge3d-web/src-ts/viewer-controls.ts`.
- Use Pointer Events for mouse, touch, and pen:
  - primary mouse drag or one touch/pen pointer: orbit;
  - middle/right mouse drag: pan;
  - two touch/pen pointers: pan by centroid and zoom by distance ratio.
- Call `setPointerCapture(pointerId)` after accepted `pointerdown`; handle
  `pointercancel`, `lostpointercapture`, `pointerup`, and `pointerleave`.
- Use one non-passive `wheel` listener on the canvas and call `preventDefault()`
  only while controls are enabled and the event is consumed.
- Suppress `contextmenu` only for a consumed right-button interaction.
- Keyboard mapping while the canvas is focused:
  arrows orbit, Shift+arrows pan, `+`/`-` zoom, and Home reset.
- Apply `touch-action: none` and a focusable `tabIndex` while controls are
  attached. Save and restore the previous inline style and tabindex on dispose.
- Coalesce pointer moves into controller state; do not call `render()` directly
  from every DOM event.
- Add an internal `OwnedDomResources` registry used for every listener and
  pointer-capture cleanup. Drive `ViewerDiagnostics.ownedListeners` and
  `activePointers` from this registry; tests must not attempt to enumerate
  browser-global listeners.

**Definition of done**

- Dragging outside the canvas after pointer capture continues the gesture and
  releases capture on completion.
- A cancelled pointer leaves no stuck button or active-pointer state.
- Two-pointer pinch and pan remain continuous when pointer order changes.
- Page scroll/zoom is prevented only over an enabled viewer gesture; normal
  document interaction outside the canvas is unaffected.
- Keyboard controls work with visible focus and do not install document-global
  key handlers.
- Creating and disposing 50 viewers yields `ownedListeners === 0`,
  `activePointers === 0`, and restored canvas attributes in the viewer's final
  diagnostic snapshot.

## FND-04 — Add Invalidation Rendering, Resize, DPR, And Visibility Handling

**Priority:** P0

**Task definition**

Render once per animation frame when state changes, resize from CSS layout, and
suspend cleanly when presentation is impossible or wasteful.

**Necessary code changes**

- Add `crates/forge3d-web/src-ts/render-scheduler.ts` with a single
  `requestAnimationFrame` slot and dirty flag.
- Add `crates/forge3d-web/src-ts/resize-controller.ts`.
- Observe the canvas content box with `ResizeObserver`. Use
  `devicePixelContentBoxSize` when available, and fall back to content-box CSS
  size multiplied by DPR; do not require the limited-availability property.
- Listen for window resize/DPR changes as a fallback. Re-read DPR before each
  committed resize.
- Clamp backing dimensions by `maxDevicePixelRatio`,
  `maxCanvasPixels`, and runtime `maxTextureDimension2D` while preserving aspect
  ratio.
- Suspend resize and rendering for zero CSS width/height instead of passing zero
  to Rust.
- Pause scheduling on `document.visibilitychange`; mark dirty and render once
  when visible.
- Handle `pagehide`/`pageshow` so BFCache restore does not duplicate listeners or
  retain a stale scheduled frame.
- Route observer and RAF allocation through owned wrappers that maintain
  `ViewerDiagnostics.activeObservers` and `pendingAnimationFrame`. Inject fake
  RAF/observer factories in unit tests; do not infer counts from browser APIs.

**Definition of done**

- One hundred pointer-move events delivered in one refresh interval cause at
  most one render submission.
- No frames are submitted while the document is hidden, the canvas is zero
  sized, or the viewer is disposed.
- CSS resize, DPR change, orientation-style width/height swap, and BFCache
  restore each produce one correct backing-store resize and one redraw.
- The backing size never exceeds the adapter dimension or configured pixel
  ceiling.
- Resize math tests include fractional CSS sizes and fractional DPR.
- Final diagnostics after disposal report zero active observers and no pending
  RAF, and fake-scheduler tests prove every allocation/deallocation transition.

## FND-05 — Bound Terrain And Screenshot Memory

**Priority:** P0 for hard GPU validation; P1 for policy presets

**Task definition**

Reject impossible allocations before copying input and remove avoidable
heightmap duplication. Provide explicit viewer budgets suitable for desktop and
mobile plans.

**Necessary code changes**

- Split direct-input parsing in `crates/forge3d-web/src/inputs.rs` into metadata
  validation and copying. Read width, height, `Float32Array.length`, color-ramp
  metadata, and checked byte/mesh sizes first. Pass runtime physical limits into
  this function; allocate the Rust `Vec<f32>` and call `copy_to` only after all
  metadata and limits pass.
- In `crates/forge3d-web/src-ts/viewer.ts`, perform the same checked
  width/height/sample/source-byte policy validation against the selected
  `ViewerResourceBudget` before invoking the low-level runtime. This protects
  viewer calls before the WASM boundary; the Rust check remains authoritative
  for direct low-level consumers.
- Change `TerrainHeightmapOptions::validate(self)` to move the `Vec<f32>` into
  `TerrainHeightmapInput` instead of cloning all heights.
- Before JavaScript-to-Rust copying or mesh generation, validate:
  - terrain width/height against `maxTextureDimension2D`;
  - vertex/index byte sizes against device buffer limits and `u32` indices;
  - sample/source byte count against the configured viewer budget;
  - `width * height` and all byte calculations with checked arithmetic.
- Implement the frozen
  `ViewerResourcePreset`/`ViewerResourceOptions`/`ViewerResourceBudget` contract.
  Policy belongs to the viewer; the low-level runtime enforces physical/API
  limits and exact payload shape.
- Preserve the most recent replayable terrain descriptor for one device
  recreation. Copy a direct heightmap once; retain URL/Blob/File/ArrayBuffer
  source descriptors without duplicate progress callbacks during recovery.
- Pass validated expected payload bytes and physical limits into
  `crates/forge3d-web/src/io.rs`. Reject a `byteLength` that is not exactly
  `width * height * 4`. Validate known Blob/ArrayBuffer/HTTP lengths before
  allocating or reading.
- For URL sources, use this unambiguous range policy:
  - accept `206` only when `Content-Range` begins at the requested offset and
    describes exactly the requested span, any `Content-Length` equals the
    expected payload bytes, and the stream contains exactly those bytes;
  - accept `200` only when the requested offset is zero, then stream at most the
    expected payload bytes; a present `Content-Length` must equal that value;
  - reject `200` as `IO_ERROR` when a nonzero range offset was requested instead
    of downloading/discarding an unbounded prefix;
  - reject `416`, malformed/mismatched `Content-Range`, truncated, and oversized
    bodies as `IO_ERROR`.
- Add only the required `web-sys` stream features in
  `crates/forge3d-web/Cargo.toml` (for example `ReadableStream` and
  `ReadableStreamDefaultReader`) and cancel the reader as soon as the bound is
  exceeded.
- Refuse screenshots whose temporary readback/encoding allocation would exceed
  the configured screenshot pixel budget.

**Definition of done**

- Direct low-level terrain validation rejects invalid length, over-limit
  dimensions, and over-limit mesh bytes before `Float32Array.copy_to`, mesh
  vectors, or GPU resources and returns `RESOURCE_LIMIT_EXCEEDED` for limits.
- A viewer-budget rejection is observable in a test spy proving that the WASM
  runtime method was never called.
- The Rust validation path makes no second full copy of the height array.
- A URL stream that exceeds expected bytes is cancelled immediately and returns
  `IO_ERROR`.
- Tests cover valid/mismatched `206`, zero-offset ignored Range with `200`,
  nonzero-offset ignored Range with `200`, `416`, truncated/oversized bodies,
  absent/dishonest `Content-Length`, and cancellation.
- The viewer can recreate the runtime and replay the last direct/source terrain
  once without invoking the caller's original progress callback a second time.
- Resource budget failures use `RESOURCE_LIMIT_EXCEEDED` and never surface as a
  WASM panic.

## FND-06 — Implement One-Time Device Recovery

**Priority:** P0

**Task definition**

Recover the high-level viewer from one unexpected GPU device loss without
creating an infinite recreation loop.

**Necessary code changes**

- Add `crates/forge3d-web/src-ts/viewer.ts` to own runtime creation options,
  current orbit view, current terrain replay descriptor, controls, scheduler,
  and resize controller.
- On `DEVICE_LOST`, stop scheduling, detach the failed runtime, create one new
  runtime on the same canvas, replay terrain and camera, reapply current size,
  and render once.
- Abort an active viewer-owned terrain source load, reject it with
  `REQUEST_CANCELLED`, and replay only the last fully committed terrain
  descriptor. Reject operational calls during recovery as frozen in FND-00.
- Serialize recovery through one promise. Ignore duplicate loss callbacks from
  the same generation.
- Transition `ready -> recovering -> ready` on success. On disabled/failed
  recovery, transition to `failed`, call `onError` exactly once for that
  generation, and retain the last diagnostics/capability snapshots for legal
  post-failure inspection.
- If recreation or replay fails, enter terminal `failed` state and invoke the
  documented error callback once. Do not retry indefinitely.
- Ensure an explicit user `dispose()` cancels or invalidates an in-flight
  recovery generation.
- Test recovery logic with an injected internal runtime factory/fake; keep the
  public API free of test-only device destruction methods.
- Increment/decrement `ViewerDiagnostics.activeRuntimes` at the single runtime
  ownership boundary so recovery/disposal leak tests use an owned counter.
- Treat `SURFACE_LOST` as the low-level surface-recreation path from FND-01. It
  must never invoke the high-level runtime factory unless device health also
  reports `DEVICE_LOST`.

**Definition of done**

- A simulated first-generation `DEVICE_LOST` recreates exactly one runtime and
  restores terrain, view, size, controls, and one rendered frame.
- A second unexpected device loss, or a failed recreation, becomes terminal and
  emits one error.
- Disposal during recovery leaves no live replacement runtime.
- Successful lost-surface recreation does not trigger full device recreation;
  an unrecoverable surface failure reports `SURFACE_LOST` without consuming the
  one allowed device recreation.
- Recovery tests prove ordering and generation guards without relying on a
  browser-specific GPU-process crash.
- Status/error callback order and the final retained diagnostic snapshot match
  the frozen FND-00 contract.

## FND-07 — Build A Truthful Cross-Browser Test Harness

**Priority:** P0

**Task definition**

Build the engine-neutral fixtures, assertions, artifact schema, package
consumer, and fail-closed rules used by browser-owned projects. This task does
not own any Playwright project, branded-browser driver, runner, or device job.

**Necessary code changes**

- Add `crates/forge3d-web/tests/playwright/interactive_viewer.spec.ts`,
  `crates/forge3d-web/tests/playwright/viewer_lifecycle.spec.ts`, and
  `crates/forge3d-web/tests/playwright/viewer_resources.spec.ts` plus package
  consumer fixture
  `crates/forge3d-web/examples/test-interactive-viewer.html`.
- Add `crates/forge3d-web/tests/browser/benchmark/` with a checked manifest,
  binary terrain, expanded camera trace, generator, and hash-verification test.
  The release-blocking workload is exactly `forge3d-viewer-benchmark-v1`:
  automatic viewer resize disabled; browser zoom and `visualViewport.scale` at
  `1`; a `320x320` CSS-pixel canvas; explicit `resize({ width: 320, height:
  320, devicePixelRatio: 2 })`; and therefore a `640x640` backing canvas.
- Generate `benchmark-terrain-v1.f32le` as a 512x512 row-major,
  little-endian-float32 file. For integer `x,y` in `[0,511]`, write:
  `base = 511 - max(abs(2*x - 511), abs(2*y - 511))`,
  `ridge = (Math.imul(x, 13) + Math.imul(y, 7)) & 31`, and
  `height = Math.fround((base + ridge) / 541)`. Require byte length `1_048_576`
  and SHA-256
  `f7ac944a3dc3736384f1082bec5f850b45d88c36ca675e9c543d945d8741e5c6`;
  the generator test fails on any byte drift.
- Generate `benchmark-trace-v1.json` with top-level key order
  `id,warmup,measurement` and view-object key order
  `target,distance,yawDegrees,pitchDegrees,fovYDegrees,near,far`; set `id` to
  `"forge3d-viewer-benchmark-trace-v1"`. Define
  `tri(p) = p <= 20 ? p : 40 - p`; every view has `fovYDegrees: 46`,
  `near: 0.01`, and `far: 100`. Its samples are exactly:
  - warm-up `i=0..119`: target `[0,0,0]`, distance `272/100`,
    yaw `i*6/10`, pitch `24 + tri(i%40)*3/10`;
  - measured orbit `j=0..199`: target `[0,0,0]`, distance `272/100`,
    yaw `(720+j*6)/10`, pitch `24 + tri(j%40)*3/10`;
  - measured pan `j=200..399`, `k=j-200`: target
    `[(k-100)/500,0,(tri(k%40)-10)/500]`, distance `272/100`, yaw `192`,
    pitch `24`;
  - measured zoom `j=400..599`, `k=j-400`: target `[0,0,0]`, distance
    `(172+abs(k-100))/100`, yaw `192`, pitch `24`.
  Encode the canonical minified JSON as UTF-8 with no BOM or trailing newline;
  it has SHA-256
  `bcef9611960ee1b0f25be529d416135ca65ec2d0571049eca1b282e6e9ad905d`.
- Freeze the canonical minified `benchmark-manifest-v1.json` to keys and values
  `id`, CSS width/height `320`, DPR `2`, backing width/height `640`, terrain
  name/hash above, trace name/hash above, `warmupSamples: 120`,
  `measurementSamples: 600`, `nominalSampleIntervalMs:
  16.666666666666668`, and `traceVersion: 1`, in that order. Its SHA-256 is
  `17493b8dc4ca3f1c43b7dc9ffbe50400d0980de20d6bb3c6a564f457eb4c6a4f`.
  Encode it as UTF-8 with no BOM or trailing newline.
  Any benchmark field or hash change requires a reviewed v2 workload rather
  than silently changing v1.

  ```json
  {"id":"forge3d-viewer-benchmark-v1","canvasCssWidth":320,"canvasCssHeight":320,"devicePixelRatio":2,"backingWidth":640,"backingHeight":640,"terrain":"benchmark-terrain-v1.f32le","terrainSha256":"f7ac944a3dc3736384f1082bec5f850b45d88c36ca675e9c543d945d8741e5c6","trace":"benchmark-trace-v1.json","traceSha256":"bcef9611960ee1b0f25be529d416135ca65ec2d0571049eca1b282e6e9ad905d","warmupSamples":120,"measurementSamples":600,"nominalSampleIntervalMs":16.666666666666668,"traceVersion":1}
  ```

- Add `crates/forge3d-web/tests/browser/viewer-benchmark.ts`. After terrain
  commit and the initial frame, focus the canvas. On each harness RAF callback,
  call `setView()` once with the next absolute trace sample, then request the
  next harness RAF; never interpolate, catch up, replay a missed sample, or
  trim a delayed interval. Discard the 120 warm-up callbacks. At the first
  measured callback, snapshot diagnostics before applying sample 0; record
  callback timestamps through a sentinel callback after sample 599, where the
  final diagnostics snapshot is taken. This yields exactly 601 monotonic
  timestamps, 600 adjacent RAF intervals, 600 applied samples, and 600 viewer
  frame submissions.
- Add shared fixtures under `crates/forge3d-web/tests/browser/` that read
  `FORGE3D_WEBGPU_REQUIRED`:
  required lanes fail on missing `navigator.gpu` or adapter; probe lanes emit a
  structured result and skip render assertions.
- Define and JSON-schema validate one browser evidence record with commit,
  package SHA-256, project/lane name, browser/version/channel, OS/build,
  architecture, device ID, headed state, secure-context state, launch arguments,
  adapter availability/fallback state, relevant limits, runtime result, frame
  counters, interaction assertions, normalized error codes, and a raw
  `benchmark` object. That object requires manifest/terrain/trace SHA-256,
  CSS/backing sizes, explicit DPR, browser zoom/viewport scale, trace version,
  `visibilityStateBefore/After`, `documentHasFocusBefore/After`,
  `visibilityChangeCount`, `windowBlurCount`, viewport scale before/after,
  power/thermal state before/after and signal provenance, warm-up/measured
  counts, `rafTimestampsMs[601]`, `rafIntervalsMs[600]`,
  `traceSamplesApplied`, `catchUpSamples`, and before/after/delta values for
  `submittedFrames` and `skippedFrames`, plus derived `measuredDurationMs`,
  `framesPerSecond`, and `p95RafIntervalMs`.
- Record browser version/UA, OS/architecture label, secure-context state,
  adapter availability, relevant limits, runtime result, frame counts, and
  error codes as a JSON artifact. Adapter identity is diagnostic, not a public
  application dependency.
- Implement assertions against `ViewerDiagnostics`; use injected
  listener/observer/RAF/runtime factories in unit tests rather than trying to
  enumerate browser-owned resources.
- Compute measured duration as
  `rafTimestampsMs[600] - rafTimestampsMs[0]`, FPS as
  `submittedFramesDelta * 1000 / measuredDurationMs`, and p95 by sorting all
  600 finite non-negative raw intervals and selecting nearest rank
  `ceil(0.95*600)-1`, zero-based index `569`. Include stalls, long frames, and
  delayed callbacks; no outlier removal, winsorization, warm-up substitution,
  or dropped-frame adjustment is permitted. The validator recomputes all 600
  intervals from adjacent timestamps and recomputes duration/FPS/p95; supplied
  interval or derived values must agree within `0.000001` ms (or
  `0.000001` FPS) and are never trusted independently.
- Fail the benchmark record instead of reporting a performance result if the
  page becomes hidden/unfocused, viewport scale or browser zoom changes,
  timestamp counts are wrong/non-monotonic, `traceSamplesApplied !== 600`,
  `catchUpSamples !== 0`, `submittedFramesDelta !== 600`, or
  `skippedFramesDelta !== 0`. Record OS/device thermal and low-power signals as
  `nominal|fair|serious|critical|unavailable` and
  `false|true|unavailable`; a known `serious`/`critical` thermal state or enabled
  low-power mode is `INFRA_ERROR` and must be rerun. `unavailable` is retained
  honestly and never rewritten as proof that throttling was absent.
- Add `crates/forge3d-web/scripts/build-browser-test-package.mjs`: run the
  existing build/package gates, create the real `.tgz` with `npm pack --json`,
  calculate SHA-256, and create a fresh temporary consumer that installs the
  tarball with
  `npm install --no-save <absolute-tarball>`. The browser fixture must be served
  from that consumer. `file:../..` remains only a developer convenience and is
  not release evidence.
- Add exact package script
  `"test:package-consumer": "node scripts/build-browser-test-package.mjs"` and
  update the lockfile,
  `crates/forge3d-web/docs/release-checklist.md`, and package contract tests for
  the shared fixtures, schema, and tarball-consumer command. Browser plans own
  their projects and workflow jobs.

**Definition of done**

- The shared assertion suite can be selected by any browser-owned project
  without browser-name branches.
- No release-required job can pass by returning `supported: false`.
- Invalid or incomplete evidence JSON fails schema validation.
- A Node golden test regenerates all v1 benchmark files byte-for-byte and
  verifies the three frozen SHA-256 values. Synthetic raw-timing records verify
  index-569 p95/FPS math and prove that a 500-ms stall, skipped frame, dropped
  trace sample, background transition, or known throttle cannot be discarded
  to manufacture a pass.
- CHR-03, FFX-03, MOB-05, and MOB-06 consume this exact benchmark ID and raw
  schema for release-blocking performance; browser plans may add endurance or
  gesture tests but may not replace or reinterpret this workload.
- Resource cleanup assertions are driven by owned/injected counters and have
  negative controls proving a deliberately leaked listener, observer, RAF, or
  runtime fails.
- The tarball consumer imports `Forge3DViewer` from `@forge3d/web`, demonstrates
  mouse, touch, keyboard, resize, unsupported UI, and disposal, and records the
  installed tarball SHA-256.
- No browser project or WebDriver implementation is created by FND-07; CHR-01,
  SAF-01/03, and FFX-01/03 own those changes.

## Shared Acceptance Commands

The final implementation must retain the existing gates and add viewer tests:

```bash
cargo fmt --all -- --check
cargo clippy -p forge3d-core --target wasm32-unknown-unknown --no-default-features -- -D warnings
cargo clippy -p forge3d-web --target wasm32-unknown-unknown -- -D warnings
cargo test -p forge3d-core
cargo test -p forge3d-web
cargo check -p forge3d-core --target wasm32-unknown-unknown --no-default-features
cargo check -p forge3d-web --target wasm32-unknown-unknown
cd crates/forge3d-web
npm ci
npm run typecheck
npm run build
npm run test:unit
npm run test:api
npm run test:package
npm run test:package-consumer
npm run test:browser
npm pack --dry-run
```

Browser-family plans add required project-specific commands and physical lanes.

## Primary References

- ECMAScript global symbol registry and `Symbol.for`:
  <https://tc39.es/ecma262/multipage/fundamental-objects.html#sec-symbol.for>
- ECMAScript `globalThis`:
  <https://tc39.es/ecma262/multipage/global-object.html#sec-globalthis>
