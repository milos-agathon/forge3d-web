# Forge3D Interactive Viewer Plan: Mobile Browsers

Date: 2026-07-27
Prerequisites:

- [shared foundation](2026-07-27-forge3d-interactive-viewer-foundation.md)
- [physical test infrastructure](2026-07-27-forge3d-interactive-viewer-test-infrastructure.md)
- completed core Chromium behavior for Chrome Android
- completed core Safari behavior for iOS/iPadOS Safari

## Scope And Support Tiers

The first mobile support contract is intentionally narrow:

- Chrome stable on physically tested Android 12+ devices with supported
  Qualcomm or ARM-family GPUs and a default hardware WebGPU adapter.
- Safari 26+ on physically tested iOS 26 and iPadOS 26 devices.

The following remain `NOT_PROVEN` until independently tested:

- Firefox stable on Android.
- Edge Android and Samsung Internet.
- Chrome, Edge, or Firefox on iOS/iPadOS. They must not be inferred from desktop
  Chromium or Safari; the actual iOS browser/embedder must expose and pass
  WebGPU.
- Android WebView and arbitrary OEM browsers.
- Any device/browser requiring an experimental flag or software adapter.

Mobile viewport emulation is useful for DOM/input preflight but is not physical
GPU, memory, thermal, lifecycle, or browser proof.

## MOB-01 — Add Mobile Capability And Unsupported-State Contract

**Priority:** P1

**Task definition**

Detect actual capability without user-agent allowlists and present a useful,
non-crashing unsupported state.

**Necessary code changes**

- Use shared checks for secure context, `navigator.gpu`, adapter acquisition,
  device creation, limits, shader/pipeline creation, and surface presentation.
- Use FND-00's frozen contract: a successful viewer exposes
  `getCapabilities()`; a failed `create()` returns a normalized
  `Forge3DError.code`. Do not add a second probe API that creates and discards a
  duplicate adapter/device.
- In FND-07's packed-tarball consumer, catch `Forge3DViewer.create()` and render
  an accessible fallback panel keyed only by the stable error code. On success,
  use the returned capability snapshot for coarse diagnostics.
- Do not instruct users to enable unsafe browser flags.
- Add mobile documentation for HTTPS, `.wasm` MIME, CORS, Range, and browser
  update requirements.

**Definition of done**

- Unsupported Android/iOS browsers show an accessible explanation and leave the
  page usable.
- Insecure origin, missing API, no adapter, device request failure, and WASM
  load failure are distinguishable.
- Capability behavior depends on APIs/results, not UA strings.
- A supported device enters the viewer without a reload or flag.
- The example has deterministic UI tests for `INSECURE_CONTEXT`,
  `WEBGPU_UNAVAILABLE`, `WEBGPU_ADAPTER_UNAVAILABLE`,
  `DEVICE_REQUEST_FAILED`, `WASM_LOAD_FAILED`, and an unexpected
  `INTERNAL_ERROR`.

## MOB-02 — Complete Native Touch And Pen Interaction

**Priority:** P1; code/emulation is implementable, physical gesture execution
is `LAB_INFRA_BLOCKED` until `browser-lab-infrastructure-readiness`

**Task definition**

Make the shared Pointer Events controller usable with real fingers, pens, and
mobile browser gesture arbitration.

**Necessary code changes**

- Use one pointer for orbit and two for simultaneous centroid pan and pinch zoom.
- Base pinch on a distance ratio from the previous accepted two-pointer sample;
  rebase when a pointer is added, removed, cancelled, or capture is lost.
- Set `touch-action: none` before a gesture starts and restore it on dispose.
- Handle implicit/explicit pointer capture, `pointercancel`, app switching, and
  a finger leaving the viewport.
- Ignore synthetic compatibility mouse events that follow consumed touch input.
- Coalesce pointer events and render at most once per RAF.
- Make any example buttons at least 44 CSS pixels in each touch dimension and
  provide text instructions outside the canvas.
- Use INF-05's host-reserved promoted manual session and physical checklist on
  all six mobile baselines. Bind each to the exact session run/job, signed
  host/device/browser/package/route inventory, capture window, and visible
  media challenge. Require
  `pointerType === "pen"` orbit/cancel evidence specifically from the in-box
  S Pen on `FW-AND-PEN-01` and the paired Apple Pencil Pro on `FW-IPAD-01`;
  touch-only phones are not claimed as pen evidence.

**Definition of done**

- One-finger orbit, two-finger pan, pinch zoom, and cancellation pass on all six
  physical mobile baselines. Pen orbit and pen cancellation pass on both named
  pen-capable baselines, one Android and one Apple.
- Adding/removing either finger does not jump the camera or leave stale pointer
  state.
- The page does not scroll or browser-zoom during a viewer gesture and behaves
  normally outside the canvas.
- Ten minutes of repeated gestures produce no stuck controls, duplicate
  listeners, or runaway render loop.
- Mobile emulation tests pass, but physical gesture evidence is retained
  separately and required.

## MOB-03 — Add Mobile Resize, Orientation, Viewport, And BFCache Handling

**Priority:** P1; code/emulation is implementable, physical lifecycle execution
is `LAB_INFRA_BLOCKED` until `browser-lab-infrastructure-readiness`

**Task definition**

Survive dynamic mobile browser chrome, rotation, background suspension, and
back-forward cache restoration.

**Necessary code changes**

- Drive canvas size from `ResizeObserver`; treat `visualViewport`/window resize
  as invalidation hints, not the authoritative size.
- Re-read DPR and CSS size after orientation and viewport changes, then apply
  the shared dimension/pixel clamp.
- Suspend on zero size, `visibilitychange`, and `pagehide`.
- On `pageshow`, render once; recreate the runtime only when shared device health
  reports actual loss.
- Add `viewport-fit=cover` and safe-area-aware layout to the example, while
  keeping safe-area UI policy outside the renderer.
- Make listener registration idempotent across BFCache restore.
- On every physical device, run thirty same-origin navigation-away /
  `history.back()` cycles. Require `pagehide.persisted === true` on departure
  and `pageshow.persisted === true` on return for every BFCache cycle; a
  `persisted === false` navigation fails the BFCache case. Run a separate
  cache-bypassing hard-reload control that requires
  `pageshow.persisted === false` and never counts toward those thirty cycles.

**Definition of done**

- Thirty portrait/landscape rotations preserve aspect ratio and camera state,
  with no zero-dimension Rust call.
- Collapsing/expanding mobile browser chrome produces bounded backing sizes and
  no resize loop.
- Thirty 30-second background/foreground cycles restore a working viewer; any
  actual device loss follows the one-retry policy.
- Thirty verified BFCache returns per device
  (`pageshow.persisted === true`) each restore one controller, observer,
  runtime, and RAF slot. Ordinary reload success cannot substitute.
- No frame is submitted while the page is hidden.

## MOB-04 — Enforce Mobile Canvas And Terrain Budgets

**Priority:** P1; code/limit tests are implementable, physical budget/endurance
execution is `LAB_INFRA_BLOCKED` until
`browser-lab-infrastructure-readiness`

**Task definition**

Prevent the current full-grid mesh architecture and screenshot path from
causing mobile process termination.

**Necessary code changes**

- Implement FND-00's frozen `resources: { preset: "mobile" }` values:
  - `maxDevicePixelRatio: 2`;
  - `maxCanvasPixels: 2_073_600`;
  - `maxTerrainSamples: 262_144` (512x512);
  - `maxSourceBytes: 1_048_576`;
  - `maxScreenshotPixels: 2_073_600`;
  - viewer power preference: explicit `none` when omitted.
- Allow `resources.budget` and `resize.maxDevicePixelRatio` overrides after
  finite-positive validation. Publishing a higher mobile default requires the
  full physical matrix; per-application callers may opt into higher values up
  to physical adapter limits.
- Apply FND-05's metadata-before-copy, move-based Rust validation, exact range
  policy, and bounded source reads.
- Reject inputs before mesh/texture allocation when sample count, texture
  dimensions, vertex bytes, index bytes, or expected source bytes exceed the
  effective budget.
- Keep screenshots inside the canvas/screenshot pixel ceiling and serialize
  screenshot requests.
- Measure and document peak memory qualitatively through device/process tools.
  The initial 512x512 ceiling is a safety starting point, not proof that every
  device can sustain a larger grid.

**Definition of done**

- A 513x513 input under the default mobile preset is rejected before full mesh
  allocation and before `Float32Array.copy_to`, with
  `RESOURCE_LIMIT_EXCEEDED`.
- A 512x512 input renders on every baseline physical device.
- Oversized URL responses abort at the expected byte ceiling.
- Repeated screenshot requests cannot overlap unbounded readback/PNG buffers.
- No baseline device reloads or terminates the tab during the 10-minute
  interaction/screenshot endurance test.
- Higher ceilings are not published until the complete physical matrix passes.

## MOB-05 — Add Android Chrome Physical Acceptance

**Priority:** P1; physical execution is `LAB_INFRA_BLOCKED` until
`browser-lab-infrastructure-readiness`

**Task definition**

Prove Chrome Android on both major GPU families covered by Chrome's stated
rollout.

**Necessary code changes**

- Register INF-05's pinned Appium/UiAutomator2 Chrome lane command in INF-04's
  manually dispatched hardware workflow for exactly:
  - `FW-AND-QCOM-01`, Samsung Galaxy S23 `SM-S911B`, Snapdragon 8 Gen 2;
  - `FW-AND-MALI-01`, Google Pixel 8, Tensor G3/Mali-G715.
- Run on the `FW-MAC-M2-01` `mobile-usb` host, install the identical packed
  tarball, and test current stable Chrome without flags through INF-03's trusted
  HTTPS route.
- Collect OS/build, Chrome version, device class, adapter result/limits, effective
  budgets, runtime errors, FND-07 raw benchmark timing, and test commit.
- Use real Appium pointer actions for one-finger gestures and multi-action
  automation for two fingers. INF-05's session-bound signed physical checklist
  remains required even when synthetic multi-action passes.
- Add a five-minute sustained gesture test and screenshot/resource test.

**Definition of done**

- Both physical Android GPU-family baselines create a hardware adapter and pass
  render, terrain, one/two-finger controls, orientation, background restore,
  screenshot, IO, and disposal.
- Both devices run FND-07's exact `forge3d-viewer-benchmark-v1`. The retained
  raw record has 600 submitted/zero skipped measured frames, calculated FPS at
  least 30, and nearest-rank p95 RAF interval at most 50 ms under FND-07's
  no-trimming/throttle rules.
- Idle viewer rendering is zero frames after the final invalidated frame.
- Five minutes of interaction causes no tab reload, device loss, unbounded queue,
  or control-state corruption.
- Android devices outside the matrix remain feature-detected/best-effort.

## MOB-06 — Add iOS And iPadOS Safari Physical Acceptance

**Priority:** P1; physical execution is `LAB_INFRA_BLOCKED` until
`browser-lab-infrastructure-readiness`

**Task definition**

Prove Safari WebGPU, touch, memory, and lifecycle behavior on physical Apple
mobile hardware.

**Necessary code changes**

- Register INF-05's pinned Appium/XCUITest Mobile Safari lane command in
  INF-04's manually dispatched hardware workflow against:
  - `FW-IOS-OLD-01`, iPhone 11, iOS 26;
  - `FW-IOS-NEW-01`, iPhone 17 Pro, iOS 26;
  - `FW-IPAD-01`, iPad Air 11-inch (M2), iPadOS 26.
- Run on `FW-MAC-M2-01`, install the identical packed npm artifact, and serve it
  through INF-03's trusted HTTPS route.
- Collect device/OS/Safari versions, adapter/limits, effective budgets, runtime
  results, FND-07 raw benchmark timing, and exact commit.
- Automate single/multi-touch where XCUITest permits and require INF-05's
  session-bound signed physical one/two-finger checklist as a release blocker
  on every device.
- Exercise Home Screen/web-app mode as P2 after Safari-tab behavior passes.

**Definition of done**

- All declared Apple device tiers pass render, 512x512 terrain, one/two-finger
  controls, rotation, 30 background/foreground cycles, thirty true BFCache
  returns with `pageshow.persisted === true`, screenshot, IO, and disposal.
- Every device runs FND-07's exact `forge3d-viewer-benchmark-v1`. The retained
  raw record has 600 submitted/zero skipped measured frames, calculated FPS at
  least 30, and nearest-rank p95 RAF interval at most 50 ms under FND-07's
  no-trimming/throttle rules. Failure blocks that declared support row and
  MOB-06 completion; narrowing support requires a reviewed matrix/plan change,
  not reinterpretation of the result.
- Idle viewer rendering stops.
- No tab process termination, permanent blank canvas, or unrecovered first
  device loss occurs in a 10-minute endurance run.
- Simulator results are retained only as preflight and never replace physical
  evidence.

## MOB-07 — Publish A Device-Qualified Mobile Matrix

**Priority:** P1; P2 for additional browsers/embedders

**Task definition**

Document mobile support by actual engine/device evidence rather than broad
"mobile browsers" language.

**Necessary code changes**

- Add separate support rows for Chrome Android, Safari iPhone, Safari iPad,
  Chrome/Edge/Firefox iOS, Firefox Android, Edge Android, Samsung Internet,
  Android WebView, and other OEM browsers in
  `crates/forge3d-web/docs/support-matrix.md`.
- Record minimum tested OS/browser, physical device/GPU tiers, effective
  default budgets, and required feature detection.
- Update package/root README, `crates/forge3d-web/docs/browser-api.md`,
  `crates/forge3d-web/docs/release-checklist.md`, package contracts, packed
  consumer example, and changelog.
- Make Android Chrome and Apple Safari physical jobs release-blocking.
- Add iOS non-Safari and Firefox Android only as non-blocking probes until each
  passes its own physical matrix without flags.

**Definition of done**

- "Mobile supported" is never used without the qualifying browser/OS/device
  rows.
- Chrome Android and Safari iOS/iPadOS exact-head artifacts are linked.
- Firefox Android, Edge Android, Samsung Internet, iOS browser embedders,
  Android WebView, and other OEM browsers stay `NOT_PROVEN` unless independently
  passed.
- Mobile budgets and performance thresholds in docs match measured release
  behavior.
- Every shared, desktop-prerequisite, and mobile-required gate is green at the
  same commit.

## Mobile Plan Acceptance Matrix

| Surface | Required status |
|---|---|
| Playwright mobile Chromium/WebKit emulation | `ENGINE_PASS`; layout/input preflight only |
| Chrome stable, Samsung Galaxy S23/Qualcomm, supported Android | `PHYSICAL_PASS` |
| Chrome stable, Google Pixel 8/Mali, supported Android | `PHYSICAL_PASS` |
| Safari 26+, iPhone 11, iOS 26 | `PHYSICAL_PASS` |
| Safari 26+, iPhone 17 Pro, iOS 26 | `PHYSICAL_PASS` |
| Safari 26+, iPad Air 11-inch (M2), iPadOS 26 | `PHYSICAL_PASS` |
| Chrome/Edge/Firefox on iOS/iPadOS | P2, `NOT_PROVEN` until independently passed |
| Firefox Android | P2, `NOT_PROVEN` |
| Edge Android | P2, `NOT_PROVEN` |
| Samsung Internet | P2, `NOT_PROVEN` |
| Android WebView/OEM browsers | P2, `NOT_PROVEN` |

## Primary References

- <https://developer.chrome.com/blog/new-in-webgpu-121>
- <https://developer.chrome.com/docs/web-platform/webgpu/troubleshooting-tips>
- <https://developer.apple.com/documentation/safari-release-notes/safari-26-release-notes>
- <https://webkit.org/blog/9395/webdriver-is-coming-to-safari-in-ios-13/>
- <https://developer.apple.com/documentation/Xcode/running-your-app-on-simulated-or-physical-devices>
- <https://www.w3.org/TR/pointerevents/>
