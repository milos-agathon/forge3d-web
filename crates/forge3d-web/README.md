# @forge3d/web

Browser-delivered Forge3D WebGPU/WASM runtime for JavaScript and TypeScript. The current release surface renders MVP terrain scenes while the tracked target covers the complete Forge3D capability baseline.

```ts
import { Forge3DRuntime } from "@forge3d/web";

const canvas = document.querySelector("canvas") as HTMLCanvasElement;
const runtime = await Forge3DRuntime.create(canvas, {
  width: 640,
  height: 360,
  devicePixelRatio: window.devicePixelRatio,
  clearColor: [0.1, 0.16, 0.24, 1]
});

runtime.setTerrain({
  width: 2,
  height: 2,
  heights: new Float32Array([0, 0.4, 0.2, 0.8])
});
runtime.render();
```

## Install

```bash
npm install @forge3d/web
```

The package is ESM-only and ships a JavaScript facade, a WebAssembly module, and hand-authored TypeScript declarations.

## Interactive Viewer Status

The emitted facade exports `Forge3DViewer` and implements the shared
FND-01..FND-07 interaction, lifecycle, recovery, resource-budget, and test
foundation. `Forge3DRuntime` remains available for immediate low-level
rendering. Browser-family support is not independently release-ready until the
required branded and physical release matrix passes; shared code completion is
not a platform support claim.

The INF-00 repository trust, fixed inventory, controller, runner-distribution,
and JIT-broker contracts are checked in but remain in explicit provisioning
state. They do not report `LAB_INFRA_READY` until the protected-main canary,
four physical controller keys, runner-absence observation, and clean one-job
JIT canaries pass. See `docs/browser-lab-runbook.md` for the activation and
custody procedure.

## Browser Support

Forge3D Web requires browser WebGPU support through `navigator.gpu`. The
required source-browser configuration targets installed branded Chrome without
unsafe WebGPU or ANGLE-forcing flags. Applications should feature-detect WebGPU
before creating the runtime and present their own fallback UI when it is
unavailable.

The default `npm run test:browser` command and
`npm run test:browser:chromium` both select bundled Playwright Chromium with
explicit preflight flags. They are preflight/`ENGINE_PASS` only and cannot
establish branded Chrome or Edge support. `npm run test:browser:chrome` and
`npm run test:browser:edge` are the unflagged required-mode branded
configurations; they fail when `navigator.gpu` or adapter acquisition is
unavailable. These configurations do not claim that either branded lane has
passed or change the current support tiers.

The configured primary publication rows are Chrome stable on exact Windows
Intel Iris Xe, Apple M2 macOS, Linux Intel Iris Xe GNOME Wayland, and Linux RTX
3070 GNOME Wayland assets, plus Edge stable on the exact Windows Intel Iris Xe
and Apple M2 macOS assets. Every row remains `NOT_PROVEN` until one attested
`RELEASE_MATRIX_READY` set generates the release's `chromium-support.md` with
the actual four-component browser versions, OS builds, displays, and exact
run-attempt links. Edge Linux remains conditional/P2. Intel Mac, AMD/Linux,
unlisted hardware, non-Wayland Linux, derivative Chromium brands, Beta, and
preflight lanes do not establish support or a browser-version floor.

`npm run test:browser:firefox-preflight` selects Playwright's patched Firefox
build with default preferences and no Chromium launch flags. CI requires
WebGPU for that project and runs the complete source-browser suite in headed
mode on a GitHub-hosted Apple-Silicon runner, but records the source benchmark
as a probe. Its separately labelled artifact can establish at most
`ENGINE_PASS`; it is not branded Firefox, physical-browser, or exact
npm-tarball evidence and leaves Firefox at `NOT_PROVEN`.

`npm run test:browser:webkit` selects the bundled Playwright WebKit engine with
no Chromium launch arguments. Hosted CI runs it only as a non-blocking macOS
engine preflight with a structured JSON report. Raw suite success is required
for the `ENGINE_PASS` artifact. When the complete suite runs and every expected
test fails at exactly the missing-`navigator.gpu` capability boundary, the
optional check reports `NOT_PROVEN` and uploads no artifact; incomplete,
malformed, mixed, or unexpected reports fail the optional check. Playwright
WebKit is not shipping Safari. This preflight cannot establish Safari support,
so Safari remains `NOT_PROVEN`.

The protected browser-lab package also carries the SAF-03 stable-Safari
acceptance mechanism. It uses the exact `selenium-webdriver` 4.35.0 client with
Apple's `/usr/bin/safaridriver`, the installed tarball fixture, native pointer,
wheel, keyboard, resize, screenshot, disposal, 30 real visibility cycles, 30
persisted-true BFCache returns, a separate persisted-false reload control, and
the complete frozen FND-07 benchmark. Its closed v1 evidence is validated again
when the lane runs, when a matrix source is created, on the hosted finalizer,
and during evidence merge. Safari Technology Preview uses its separately
inventoried bundle driver and is probe-only; it can warn on product failure but
cleanup uncertainty fails the job. These mechanisms do not claim a physical
pass: Safari stays `NOT_PROVEN` until the protected physical matrix succeeds.

See `docs/support-matrix.md` for browser evidence status, product boundaries, tracked feature gaps, and release-lane requirements.

## MIME, CORS, And Range Requirements

Serve `.wasm` files with `Content-Type: application/wasm`. The package loads `dist/forge3d_web_bg.wasm` next to the generated bridge module, so bundlers and static hosts must preserve that asset URL.

URL terrain sources use browser `fetch`. Cross-origin terrain URLs need normal CORS headers. Byte-range terrain reads request `Range` headers when `byteOffset` or `byteLength` is supplied; servers that do not support range responses may return the full object, which the browser adapter validates before upload.

Cache `.wasm` assets with immutable content hashing, or invalidate the wasm asset whenever `dist/forge3d_web_bg.wasm` changes. Avoid long-lived cache headers on unhashed wasm URLs unless the deployment pipeline also performs explicit cache purges.

## Public API

- `Forge3DRuntime.create(canvas, options)`
- `Forge3DRuntime.getCapabilities()`
- `Forge3DViewer.create(canvas, options)`
- viewer orbit, pan, zoom, automatic resize, invalidation rendering, recovery,
  diagnostics, resource budgets, screenshots, and deterministic disposal
- `setTerrain({ width, height, heights })`
- `setTerrainFromSource({ width, height, source, byteOffset, byteLength, signal, onProgress })`
- `setCamera(camera)`
- `resize({ width, height, devicePixelRatio })`
- `render()`
- `screenshot()`
- `dispose()`

See `docs/browser-api.md` for the stable TypeScript contract, lifecycle rules,
and error codes.

## Current Surface And Parity Gaps

The current package includes canvas-backed WebGPU rendering, camera and resize
control, Float32 heightmaps, URL/File/Blob/ArrayBuffer terrain byte sources,
screenshots, and TypeScript declarations. This is the implemented release
surface, not the final parity boundary.

| Capability | Current status | Parity owner |
|---|---|---|
| Worker `OffscreenCanvas` and browser-headless output | Current gap | [R10-R11](https://github.com/milos-agathon/forge3d/blob/main/docs/superpowers/plans/2026-06-04-forge3d-browser-webgpu-wasm-runtime.md#runtime-gpu-and-platform-foundations), [W02](https://github.com/milos-agathon/forge3d/blob/main/docs/superpowers/plans/2026-06-04-forge3d-browser-webgpu-wasm-runtime.md#w02--general-scenerender-graph-resources-diagnostics-and-config) |
| COPC/EPT/LAZ point streaming | Current gap | [G02-G03](https://github.com/milos-agathon/forge3d/blob/main/docs/superpowers/plans/2026-06-04-forge3d-browser-webgpu-wasm-runtime.md#geospatial-data-geometry-acceleration-and-ray-rendering), [W16](https://github.com/milos-agathon/forge3d/blob/main/docs/superpowers/plans/2026-06-04-forge3d-browser-webgpu-wasm-runtime.md#w16--point-clouds-and-ogc-3d-tiles) |
| OGC 3D Tiles | Current gap | [G04](https://github.com/milos-agathon/forge3d/blob/main/docs/superpowers/plans/2026-06-04-forge3d-browser-webgpu-wasm-runtime.md#geospatial-data-geometry-acceleration-and-ray-rendering), [W16](https://github.com/milos-agathon/forge3d/blob/main/docs/superpowers/plans/2026-06-04-forge3d-browser-webgpu-wasm-runtime.md#w16--point-clouds-and-ogc-3d-tiles) |
| COG and raster streaming/overlays | Current gap | [T09-T11](https://github.com/milos-agathon/forge3d/blob/main/docs/superpowers/plans/2026-06-04-forge3d-browser-webgpu-wasm-runtime.md#terrain-and-large-raster-scenes), [W08](https://github.com/milos-agathon/forge3d/blob/main/docs/superpowers/plans/2026-06-04-forge3d-browser-webgpu-wasm-runtime.md#w08--clipmaps-streaming-cog-raster-overlays-and-virtual-textures) |
| Mapbox Style subset | Current gap | [M03](https://github.com/milos-agathon/forge3d/blob/main/docs/superpowers/plans/2026-06-04-forge3d-browser-webgpu-wasm-runtime.md#product-scene-styling-packaging-cartography-and-utilities), [W19](https://github.com/milos-agathon/forge3d/blob/main/docs/superpowers/plans/2026-06-04-forge3d-browser-webgpu-wasm-runtime.md#w19--mapbox-style-bundles-variants-and-review-layers) |

Python wheels, PyO3/NumPy bindings, native windows, stdin/TCP control, and CMake
are delivery mechanisms rather than feature gaps. Their observable outcomes map
to browser equivalents in the
[exhaustive parity matrix](https://github.com/milos-agathon/forge3d/blob/main/docs/superpowers/plans/2026-06-04-forge3d-browser-webgpu-wasm-runtime.md#exhaustive-parity-matrix).
WebGL fallback and Node rendering are explicit entries in the
[tombstone ledger](https://github.com/milos-agathon/forge3d/blob/main/docs/superpowers/plans/2026-06-04-forge3d-browser-webgpu-wasm-runtime.md#truthfulness-lifecycle-and-tombstone-ledger),
not silent parity exclusions. Complete functional parity is not claimed while
any active row in the
[composite parity manifest](https://github.com/milos-agathon/forge3d/blob/main/docs/parity/forge3d-composite-baseline.json)
remains open.

## Release Verification

See `docs/release-checklist.md` for the full prerelease checklist and
`docs/browser-lab-runbook.md` for physical-laboratory activation. At minimum,
package verification runs:

```bash
npm run verify:parity
npm run typecheck
npm run build
npm run test:api
npm run test:package
npm run test:package-consumer
npm run test:browser:chrome
npm pack --dry-run
```

## License

Apache-2.0 OR MIT.
