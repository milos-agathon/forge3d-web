# Forge3D Web Support Matrix

This matrix defines the browser WebGPU/WASM MVP support contract for the
`@forge3d/web` prerelease. It describes the tested surface, unsupported
surfaces, and deployment assumptions that application owners must satisfy.

## Browser And Runtime Support

| Surface | MVP status | Notes |
|---|---|---|
| Chrome/Chromium on Windows | Required | CI and local release verification run Chrome/Chromium with WebGPU enabled and `FORGE3D_WEBGPU_REQUIRED=1`. |
| Chrome/Chromium on macOS/Linux | Best effort | Expected to work when `navigator.gpu` is available, but not required for the MVP release gate. |
| Edge | Best effort | Chromium-based Edge should follow Chrome WebGPU behavior, but the required lane remains Chrome/Chromium. |
| Firefox | Unsupported | WebGPU availability and behavior are not part of the MVP contract. |
| Safari | Unsupported | Safari WebGPU is not part of the MVP contract. |
| Mobile browsers | Unsupported | Touch UX, memory ceilings, and browser WebGPU variability are post-MVP work. |
| WebGL fallback | Unsupported | Applications must feature-detect WebGPU and provide their own fallback UI. |
| Node.js rendering | Unsupported | The package is browser-only and requires an `HTMLCanvasElement`. |
| OffscreenCanvas | Unsupported | The MVP runtime owns a main-thread canvas-backed WebGPU surface. |
| Python/native parity | Unsupported | Python wheels and the native viewer are verified separately; their APIs are not exposed by `@forge3d/web`. |

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

## Required Release Lane

The required browser lane is the web CI workflow plus local release checklist:

```powershell
$env:FORGE3D_WEBGPU_REQUIRED = "1"
npm run test:browser
```

If `navigator.gpu` or adapter acquisition fails in that lane, the release is
blocked until the environment issue is documented or the runtime issue is fixed.

