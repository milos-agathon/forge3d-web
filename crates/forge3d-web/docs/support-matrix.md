# Forge3D Web Support Matrix

This matrix defines the browser WebGPU/WASM MVP support contract for the
`@forge3d/web` prerelease. It describes the tested surface, unsupported
surfaces, and deployment assumptions that application owners must satisfy.

## Browser And Runtime Support

| Surface | MVP status | Notes |
|---|---|---|
| Chrome/Chromium on Windows | Required | Required source and exact-tarball configurations use unflagged branded Chrome. Hosted CI exercises the exact tarball in flagged bundled Chromium as `PROBE` when only a fallback adapter is available. Promotion still requires a branded, physical, non-fallback Windows run. |
| Chrome/Chromium on macOS/Linux | Best effort | Expected to work when `navigator.gpu` is available, but not required for the MVP release gate. |
| Edge | Best effort | `test:browser:edge` is an unflagged branded required-mode configuration, but the current Edge support tier remains best effort until the required evidence exists. |
| Playwright WebKit test engine | Engine preflight only | The non-blocking macOS `test:browser:webkit` lane uses no Chromium flags and may produce `ENGINE_PASS` only after the complete suite succeeds. Playwright WebKit is not shipping Safari and cannot establish a Safari support row. |
| Firefox | Unsupported | WebGPU availability and behavior are not part of the MVP contract. |
| Safari | Unsupported | `NOT_PROVEN`: neither Playwright WebKit nor structural CI is shipping Safari evidence. Safari WebGPU is not part of the MVP contract. |
| Mobile browsers | Unsupported | Touch UX, memory ceilings, and browser WebGPU variability are post-MVP work. |
| WebGL fallback | Unsupported | Applications must feature-detect WebGPU and provide their own fallback UI. |
| Node.js rendering | Unsupported | The package is browser-only and requires an `HTMLCanvasElement`. |
| OffscreenCanvas | Unsupported | The MVP runtime owns a main-thread canvas-backed WebGPU surface. |
| Python/native parity | Unsupported | Python wheels and the native viewer are out of scope for this browser/npm/WASM repository. |

## Deployment Requirements

- Serve `.wasm` assets with `Content-Type: application/wasm`.
- Preserve the package-local wasm URL emitted by the bundler or static host.
- Cache `.wasm` assets with immutable content hashing, or use a deploy process
  that invalidates the asset whenever `dist/forge3d_web_bg.wasm` changes.
- Cross-origin terrain URL sources must send CORS headers that allow browser
  `fetch` from the application origin.
- Byte-range terrain reads may send a `Range` header when `byteOffset` or
  `byteLength` is supplied. Servers may return either the requested partial
  object or a full object that still satisfies the requested byte slice.
- Applications must check `navigator.gpu` before calling
  `Forge3DRuntime.create(canvas, options)`.

## Browser Test Configurations

The default `npm run test:browser` command aliases
`npm run test:browser:chromium`. Both select bundled Playwright Chromium with
the explicit unsafe-WebGPU preflight flag and, on Windows, the D3D11 ANGLE
flag. This is flagged preflight evidence only and can establish at most
`ENGINE_PASS`; it cannot establish branded Chrome or Edge support.

`npm run test:browser:chrome` and `npm run test:browser:edge` select the
installed branded Chrome and Edge channels without unsafe WebGPU,
GPU-blocklist, Vulkan-enable, or ANGLE-forcing flags. These normal branded
configurations use required evidence mode by default and fail if
`navigator.gpu` or adapter acquisition is unavailable. Their presence does not
claim that either branded run has passed or change any support tier in this
matrix.

`npm run test:browser:webkit` selects bundled Playwright WebKit without
Chromium unsafe-WebGPU, GPU-blocklist, Vulkan-enable, or ANGLE-forcing
arguments. Its hosted macOS job is explicitly non-blocking engine preflight.
Only a successful complete run uploads the artifact named
`forge3d-web-playwright-webkit-ENGINE_PASS`; a failed run produces no
`ENGINE_PASS` artifact. This engine result is not branded or physical Safari
evidence, so Safari remains unsupported/`NOT_PROVEN`.

## Required Release Lane

The required browser lane is the web CI workflow plus local release checklist:

```powershell
$env:FORGE3D_PACKAGE_GATE_MODE = "required"
$env:FORGE3D_SOURCE_BENCHMARK_MODE = "required"
$env:FORGE3D_WEBGPU_REQUIRED = "1"
npm run test:package-consumer
npm run test:browser:chrome
```

If `navigator.gpu` or adapter acquisition fails in that lane, the release is
blocked until the environment issue is documented or the runtime issue is fixed.
