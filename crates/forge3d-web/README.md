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

## Browser Support

Forge3D Web requires browser WebGPU support through `navigator.gpu`. The MVP verification lane targets current Chrome/Chromium with WebGPU enabled. Applications should feature-detect WebGPU before creating the runtime and present their own fallback UI when it is unavailable.

See `docs/support-matrix.md` for the browser support matrix, unsupported surfaces, and release-lane requirements.

## MIME, CORS, And Range Requirements

Serve `.wasm` files with `Content-Type: application/wasm`. The package loads `dist/forge3d_web_bg.wasm` next to the generated bridge module, so bundlers and static hosts must preserve that asset URL.

URL terrain sources use browser `fetch`. Cross-origin terrain URLs need normal CORS headers. Byte-range terrain reads request `Range` headers when `byteOffset` or `byteLength` is supplied; servers that do not support range responses may return the full object, which the browser adapter validates before upload.

Cache `.wasm` assets with immutable content hashing, or invalidate the wasm asset whenever `dist/forge3d_web_bg.wasm` changes. Avoid long-lived cache headers on unhashed wasm URLs unless the deployment pipeline also performs explicit cache purges.

## Public API

- `Forge3DRuntime.create(canvas, options)`
- `setTerrain({ width, height, heights })`
- `setTerrainFromSource({ width, height, source, byteOffset, byteLength, signal, onProgress })`
- `setCamera(camera)`
- `resize({ width, height, devicePixelRatio })`
- `render()`
- `screenshot()`
- `dispose()`

See `docs/browser-api.md` for the stable TypeScript API and error codes.

## MVP Scope And Exclusions

The browser MVP includes canvas-backed WebGPU rendering, camera and resize control, Float32 heightmaps, URL/File/Blob/ArrayBuffer terrain byte sources, screenshots, and TypeScript declarations.

The MVP does not include Python APIs, native windows, TCP or stdin control, COPC/EPT/LAZ streaming, 3D Tiles, COG/raster streaming, Mapbox Style parity, WebGL fallback, or Python/native feature parity.

## Release Verification

See `docs/release-checklist.md` for the full prerelease checklist. At minimum, package verification runs:

```bash
npm run typecheck
npm run build
npm run test:api
npm run test:package
npm run test:browser
npm pack --dry-run
```

## License

Apache-2.0 OR MIT.
