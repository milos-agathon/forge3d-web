# Forge3D Web Support Matrix

This matrix defines the browser WebGPU/WASM MVP support contract for the
`@forge3d/web` prerelease. It describes the tested surface, unsupported
surfaces, and deployment assumptions that application owners must satisfy.

## Browser And Runtime Support

| Surface | MVP status | Notes |
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
| Firefox | Unsupported | `test:browser:firefox-preflight` exercises Playwright's patched Firefox in headed mode on GitHub-hosted Apple Silicon with default preferences and no Chromium flags. A passing run is `ENGINE_PASS` source-browser evidence only, not branded Firefox, physical-browser, exact-tarball, or support evidence. |
| Playwright WebKit test engine | Engine preflight only | The non-blocking macOS `test:browser:webkit` lane uses no Chromium flags and may produce `ENGINE_PASS` only after the complete suite succeeds. Playwright WebKit is not shipping Safari and cannot establish a Safari support row. |
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
evidence. The Firefox row remains `Unsupported`.

`npm run test:browser:webkit` selects bundled Playwright WebKit without
Chromium unsafe-WebGPU, GPU-blocklist, Vulkan-enable, or ANGLE-forcing
arguments. Its hosted macOS job is explicitly non-blocking engine preflight.
Only raw success from a complete structured Playwright report uploads the
artifact named `forge3d-web-playwright-webkit-ENGINE_PASS`. A complete run in
which every expected test fails at exactly the missing-`navigator.gpu`
capability boundary reports `NOT_PROVEN` and uploads no artifact. Missing,
malformed, incomplete, mixed, or unexpected reports fail the optional check.
This engine result is not branded or physical Safari evidence, so Safari
remains unsupported/`NOT_PROVEN`.

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
