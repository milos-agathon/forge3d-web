# Forge3D Web Support Matrix

This matrix defines browser/OS/GPU evidence for the `@forge3d/web` prerelease,
plus browser product boundaries and current feature gaps. Browser support
status is independent of functional-parity scope: a `NOT_PROVEN` lane does not
remove a capability from the parity target.

`Supported` may be published only from the required attested physical evidence.
`NOT_PROVEN` means no support claim. `Tracked feature gap` means the capability
is open in the parity matrix and must link to its row and task. `Product
boundary` means the
[composite manifest](https://github.com/milos-agathon/forge3d/blob/main/docs/parity/forge3d-composite-baseline.json)
records an explicit tombstone rather than a native capability omission.

## Browser And Runtime Support

| Surface | Evidence status | Notes |
|---|---|---|
| Chrome stable on Windows 11, Intel Iris Xe | Required physical lane, `NOT_PROVEN` | Publication requires exact asset `FW-WIN-I12-01` (Intel NUC 12 Pro, Core i5-1240P, Iris Xe, x86-64), an observed four-component stable Chrome version and Windows build, unflagged launch arguments, and non-fallback presentation. This exact Windows requirement is not satisfied by Linux, macOS, or bundled Chromium evidence. |
| Chrome stable on Apple Silicon macOS | Required physical lane, `NOT_PROVEN` | Publication requires exact asset `FW-MAC-M2-01` (Mac mini 2023, Apple M2 CPU/GPU, arm64), an observed four-component stable Chrome version and macOS build, unflagged launch arguments, and non-fallback presentation. |
| Chrome stable on Intel macOS | P2, `NOT_PROVEN` | No exact Intel Mac asset or qualifying result exists. Evidence from Apple Silicon cannot satisfy this row. |
| Chrome stable on Linux Intel Gen12+ Wayland | Required physical lane, `NOT_PROVEN` | Publication requires exact asset `FW-LNX-I12-01` (Intel NUC 12 Pro, Core i5-1240P, Iris Xe, x86-64), an observed four-component stable Chrome version and Ubuntu build, and a real GNOME Wayland session. |
| Chrome stable on Linux NVIDIA RTX 3070 Wayland | Required physical lane, `NOT_PROVEN` | Publication requires exact asset `FW-LNX-NV-01` (ThinkStation P360, Core i7-12700, RTX 3070 8 GB, x86-64), an observed four-component stable Chrome version and Ubuntu build, and a real GNOME Wayland session. |
| Chrome stable on AMD/Linux | P2, `NOT_PROVEN` | No exact AMD/Linux asset or qualifying result exists. Intel or NVIDIA evidence cannot satisfy this row. |
| Chrome Beta on the CHR-03 assets | Optional probe | Non-blocking early warning only. Beta is never a required release row and cannot replace stable Chrome evidence. |
| Edge stable on Windows 11 Intel Gen12+ | Required physical lane, `NOT_PROVEN` | Publication requires branded stable `msedge` through `playwright-edge` on exact asset `FW-WIN-I12-01`, with an observed four-component Edge version and Windows build, safe launch arguments, and non-fallback hardware presentation. |
| Edge stable on Apple Silicon macOS | Required physical lane, `NOT_PROVEN` | Publication requires branded stable `msedge` through `playwright-edge` on exact asset `FW-MAC-M2-01`, with an observed four-component Edge version and macOS build, safe launch arguments, and non-fallback hardware presentation. |
| Edge stable on Linux GNOME Wayland | Conditional physical lanes, `NOT_PROVEN` | CHR-04 accepts only exact assets `FW-LNX-I12-01` and `FW-LNX-NV-01` when live provenance observes GNOME Wayland, branded `msedge` stable, safe launch arguments, and non-fallback hardware presentation. No qualifying physical result exists. |
| Firefox | `NOT_PROVEN` | `test:browser:firefox-preflight` exercises Playwright's patched Firefox in headed mode on GitHub-hosted Apple Silicon with default preferences and no Chromium flags. A passing run is `ENGINE_PASS` source-browser evidence only. Browser-family closure is owned by [W24](https://github.com/milos-agathon/forge3d/blob/main/docs/superpowers/plans/2026-06-04-forge3d-browser-webgpu-wasm-runtime.md#w24--cross-browser-performance-recovery-packaging-and-final-closure). |
| Playwright WebKit test engine | Engine preflight only | The non-blocking macOS `test:browser:webkit` lane uses no Chromium flags and may produce `ENGINE_PASS` only after the complete suite succeeds. Playwright WebKit is not shipping Safari and cannot establish a Safari support row. |
| Safari | `NOT_PROVEN` | SAF-03 provides fail-closed stable SafariDriver/Selenium 4.35.0 acceptance and a separately inventoried, probe-only Technology Preview result, but no protected physical SAF-03 record is present. Browser-family closure is owned by [W24](https://github.com/milos-agathon/forge3d/blob/main/docs/superpowers/plans/2026-06-04-forge3d-browser-webgpu-wasm-runtime.md#w24--cross-browser-performance-recovery-packaging-and-final-closure). |
| Mobile browsers | `NOT_PROVEN` | Touch and mobile resource behavior exist, but no required physical mobile support lane is complete. Cross-browser publication remains [W24](https://github.com/milos-agathon/forge3d/blob/main/docs/superpowers/plans/2026-06-04-forge3d-browser-webgpu-wasm-runtime.md#w24--cross-browser-performance-recovery-packaging-and-final-closure). |
| WebGL fallback | Product boundary | WebGPU browser execution is recorded by the [WebGL product-boundary tombstone](https://github.com/milos-agathon/forge3d/blob/main/docs/superpowers/plans/2026-06-04-forge3d-browser-webgpu-wasm-runtime.md#truthfulness-lifecycle-and-tombstone-ledger); final packaging enforcement belongs to [W24](https://github.com/milos-agathon/forge3d/blob/main/docs/superpowers/plans/2026-06-04-forge3d-browser-webgpu-wasm-runtime.md#w24--cross-browser-performance-recovery-packaging-and-final-closure). Applications must feature-detect WebGPU and provide their own fallback UI. |
| Node.js rendering | Product boundary | Node rendering is recorded by the [Node product-boundary tombstone](https://github.com/milos-agathon/forge3d/blob/main/docs/superpowers/plans/2026-06-04-forge3d-browser-webgpu-wasm-runtime.md#truthfulness-lifecycle-and-tombstone-ledger); browser-headless outcomes remain tracked by [R11/W02](https://github.com/milos-agathon/forge3d/blob/main/docs/superpowers/plans/2026-06-04-forge3d-browser-webgpu-wasm-runtime.md#runtime-gpu-and-platform-foundations). |
| `OffscreenCanvas` | Tracked feature gap | Worker and hidden-canvas equivalents are tracked by [R10-R11](https://github.com/milos-agathon/forge3d/blob/main/docs/superpowers/plans/2026-06-04-forge3d-browser-webgpu-wasm-runtime.md#runtime-gpu-and-platform-foundations) and [W02](https://github.com/milos-agathon/forge3d/blob/main/docs/superpowers/plans/2026-06-04-forge3d-browser-webgpu-wasm-runtime.md#w02--general-scenerender-graph-resources-diagnostics-and-config). The current runtime owns a main-thread canvas-backed surface. |
| Lights, BRDF materials, textures/KTX2, IBL, shadows (W04) | Implemented; Chromium preflight evidence only | P01-P07 run in the flagged Chromium preflight lane, including the native `terrain_pbr_pom` screen-mode golden at SSIM >= 0.98. Branded and physical browser rows above still govern support claims. |
| Forge3D functional parity | In progress | The [exhaustive parity matrix](https://github.com/milos-agathon/forge3d/blob/main/docs/superpowers/plans/2026-06-04-forge3d-browser-webgpu-wasm-runtime.md#exhaustive-parity-matrix) and [ordered W00-W24 tasks](https://github.com/milos-agathon/forge3d/blob/main/docs/superpowers/plans/2026-06-04-forge3d-browser-webgpu-wasm-runtime.md#ordered-implementation-tasks) own every current gap. Complete parity is not claimed while any active row is open. |

## Deployment Requirements

- Serve `.wasm` assets with `Content-Type: application/wasm`.
- Preserve the package-local wasm URL emitted by the bundler or static host.
- Preserve `assets/basis/basis_transcoder.{js,wasm}` (or pass `basisJsUrl` and
  `basisWasmUrl`) when using `Ktx2Loader` with Basis Universal payloads; no
  CDN fallback exists.
- `IblCache` needs CacheStorage or OPFS (secure contexts). Without either it
  reports `cacheBackend: "none"` and recomputes IBL on the GPU.
- Natively compressed KTX2 (BC/ETC2/ASTC) needs the matching
  `texture-compression-*` adapter feature. Otherwise it is rejected with
  `UNSUPPORTED_FEATURE`, never silently decompressed.
- Cache `.wasm` assets with immutable content hashing, or use a deploy process
  that invalidates the asset whenever `dist/forge3d_web_bg.wasm` changes.
- Cross-origin terrain URL sources must send CORS headers that allow browser
  `fetch` from the application origin.
- Byte-range terrain reads may send a `Range` header when `byteOffset` or
  `byteLength` is supplied. A nonzero-offset request requires the exact `206`
  response and `Content-Range`; a full `200` response is accepted only for an
  exact zero-offset body.
- Applications should handle the stable `WEBGPU_UNAVAILABLE` and
  `WEBGPU_ADAPTER_UNAVAILABLE` errors from the public runtime/viewer API and
  show an unsupported-state UI. Browser or organization policy and disabled
  graphics acceleration can make adapter acquisition unavailable.

## Browser Test Configurations

The six primary configured rows are
`chrome-windows-intel12`, `chrome-macos-m2`, `chrome-linux-intel12`,
`chrome-linux-rtx3070`, `edge-windows-intel12`, and `edge-macos-m2` on the exact
assets named above. Their current status remains `NOT_PROVEN`. A supported
release must contain generated `chromium-support.md`; that artifact derives the
actual browser versions, OS builds, displays, package digest, and exact run and
attempt links from the attested closed 24-key matrix. Static policy
`minimumMajor` values are update controls and never become a support floor.

Edge Linux stays conditional/P2. Intel Mac, AMD/Linux, unlisted hardware,
non-Wayland Linux, and derivative Chromium brands remain `NOT_PROVEN`. Chrome
Beta and browser preflight lanes cannot promote support.

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

`npm run test:browser:firefox-preflight` selects Playwright's patched Firefox
with default preferences and no Chromium launch flags. The GitHub-hosted
Apple-Silicon lane sets `FORGE3D_HEADED=1` and `FORGE3D_WEBGPU_REQUIRED=1`, so
missing WebGPU or adapter acquisition fails instead of turning required render
behavior into a skip. It also sets
`FORGE3D_SOURCE_BENCHMARK_MODE=probe`, keeping the resulting artifact at
`ENGINE_PASS` rather than branded, physical, exact-tarball, or release-support
evidence. The Firefox row remains `NOT_PROVEN`.

`npm run test:browser:webkit` selects bundled Playwright WebKit without
Chromium unsafe-WebGPU, GPU-blocklist, Vulkan-enable, or ANGLE-forcing
arguments. Its hosted macOS job is explicitly non-blocking engine preflight.
Only raw success from a complete structured Playwright report uploads the
artifact named `forge3d-web-playwright-webkit-ENGINE_PASS`. A complete run in
which every expected test fails at exactly the missing-`navigator.gpu`
capability boundary reports `NOT_PROVEN` and uploads no artifact. Missing,
malformed, incomplete, mixed, or unexpected reports fail the optional check.
This engine result is not branded or physical Safari evidence, so Safari
remains `NOT_PROVEN`.

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
