# @forge3d/web

Browser-only Forge3D WebGPU/WASM runtime for rendering MVP terrain scenes from JavaScript and TypeScript.

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

`npm run test:browser:firefox-preflight` selects Playwright's patched Firefox
build with default preferences and no Chromium launch flags. CI requires
WebGPU for that project and runs the complete source-browser suite in headed
mode, but records the source benchmark as a probe. Its separately labelled
artifact can establish at most `ENGINE_PASS`; it is not branded Firefox,
physical-browser, or exact npm-tarball evidence and does not promote Firefox
from `Unsupported`.

See `docs/support-matrix.md` for the browser support matrix, unsupported surfaces, and release-lane requirements.

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

## MVP Scope And Exclusions

The browser MVP includes canvas-backed WebGPU rendering, camera and resize control, Float32 heightmaps, URL/File/Blob/ArrayBuffer terrain byte sources, screenshots, and TypeScript declarations.

The MVP does not include Python APIs, native windows, TCP or stdin control, COPC/EPT/LAZ streaming, 3D Tiles, COG/raster streaming, Mapbox Style parity, WebGL fallback, or Python/native feature parity.

## Release Verification

See `docs/release-checklist.md` for the full prerelease checklist and
`docs/browser-lab-runbook.md` for physical-laboratory activation. At minimum,
package verification runs:

```bash
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
