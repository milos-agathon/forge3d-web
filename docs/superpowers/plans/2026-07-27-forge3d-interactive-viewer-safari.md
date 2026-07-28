# Forge3D Interactive Viewer Plan: Safari

Date: 2026-07-27
Prerequisite: [shared foundation](2026-07-27-forge3d-interactive-viewer-foundation.md)
Physical prerequisite:
[test infrastructure](2026-07-27-forge3d-interactive-viewer-test-infrastructure.md)

## Scope And Support Tiers

The required first Safari tier is shipping Safari 26+ on macOS 26 on Apple
Silicon. Safari Technology Preview is an early-warning lane. Safari 26 on
macOS Sequoia/Sonoma and Intel Mac remains an expansion lane until physical
testing proves `navigator.gpu`, adapter creation, and the complete viewer.

This plan does not use Playwright WebKit as shipping Safari proof. Playwright
documents that its WebKit build tracks WebKit main and is not branded Safari.

Mobile Safari is covered by the mobile plan after this desktop WebKit path is
stable.

## SAF-01 — Add WebKit Preflight Without Claiming Safari

**Priority:** P1

**Task definition**

Catch standards-level and WebKit regressions early while keeping evidence labels
honest.

**Necessary code changes**

- Add a `webkit-preflight` project to
  `crates/forge3d-web/playwright.config.ts`, executed on macOS.
- Install Playwright WebKit in a non-blocking engine-preflight job.
- Run the same interactive viewer fixture and assertion payload as Chromium.
- Remove assumptions from test helpers that the browser name is `chrome`.
- Use behavior/luma thresholds instead of exact cross-engine screenshots.
- Label all WebKit artifacts `ENGINE_PASS`, never `BRANDED_PASS`.

**Definition of done**

- The full render, terrain, interaction, resize, screenshot, IO, and disposal
  suite runs in Playwright WebKit on macOS.
- No Chromium launch argument reaches WebKit.
- Cross-engine image tests tolerate color/presentation differences without
  accepting a blank or unchanged frame.
- Documentation and CI names cannot be read as "Safari passed."

## SAF-02 — Verify Core WebGPU/WGSL And WASM Behavior In Shipping Safari

**Priority:** P1; code/preflight is implementable, shipping-Safari physical
execution is `LAB_INFRA_BLOCKED` until
`browser-lab-infrastructure-readiness`

**Task definition**

Prove the existing wgpu/WASM render path in stable Safari and change code only
for reduced, reproducible conformance failures.

**Necessary code changes**

- Use FND-01 shader/pipeline error scopes to capture Metal/WebKit validation
  failures with labels.
- Keep the baseline shader limited to core WGSL and required WebGPU formats.
  Do not introduce Safari-only shader source.
- Verify `R32Float` non-filtering sampling, `Depth24Plus`, uniform layout,
  surface alpha-mode selection, BGRA/RGBA screenshot normalization, buffer
  mapping, and PNG `toBlob`.
- If a WebKit failure is isolated to the unnecessary sampled height lookup,
  replace the vertex-stage `textureSampleLevel` and sampler binding with integer
  `textureLoad` derived from UV for all browsers; do not add a Safari branch.
- Add an HTTPS fixture that verifies ESM import and `.wasm`
  `Content-Type: application/wasm` through FND-01's explicit validated
  `wasmUrl` fetch. Test failed-load cache reset by correcting the route and
  creating again.
- Test same-origin and CORS terrain fetches plus FND-05's exact range policy:
  valid `206`, zero-offset `200`, rejected nonzero-offset `200`, and `416`.
- Use INF-03's publicly trusted HTTPS origin for physical Safari. Do not permit
  a self-signed certificate, certificate-warning click-through, or TLS bypass.
- Keep the repository on the current wgpu patch unless the same reduced case
  proves that a reviewed patch upgrade fixes Safari without regressing other
  engines.

**Definition of done**

- Stable Safari creates an adapter/device/surface without a feature flag.
- Terrain is visibly rendered and changes after a camera interaction.
- The console and viewer report contain no uncaptured WebGPU validation error.
- Screenshot returns a valid non-empty PNG with correct dimensions and visible
  terrain.
- Bad WASM MIME and WASM CORS rejection return `WASM_LOAD_FAILED`; terrain CORS
  and range failures return `IO_ERROR`.
- A failed WASM initialization does not poison later creation after the route is
  corrected.
- Any renderer change made for Safari passes every existing Chromium and Rust
  gate and has a reduced regression test.

## SAF-03 — Add Real SafariDriver Acceptance

**Priority:** P1; physical execution is `LAB_INFRA_BLOCKED` until
`browser-lab-infrastructure-readiness`

**Task definition**

Automate the shipping Safari application using Apple's `safaridriver`, not a
look-alike WebKit binary.

**Necessary code changes**

- Add a pinned Selenium/WebDriver client as a dev dependency and implement
  `crates/forge3d-web/tests/webdriver/safari-viewer.mjs`.
- Reuse FND-07's packed
  `crates/forge3d-web/examples/test-interactive-viewer.html` consumer and
  structured assertion API.
- Register a Safari lane command in INF-04's dispatch workflow for
  `FW-MAC-M2-01` using labels
  `[forge3d-web, hw-mac-m2, ${{ needs.promote.outputs.runner_nonce_label }}]`.
  This is INF-04's repository-level JIT runner. Its workflow selector uses only
  the three authorization-bound custom labels; any GitHub-generated read-only
  platform labels are non-authoritative. Its promotion-generated third custom
  label is the unique `jit-<runner-nonce>`.
  INF-01 enables Safari remote automation during runner provisioning and the
  job launches `/usr/bin/safaridriver`.
- Collect Safari version, macOS build, architecture, secure-context state,
  adapter result, runtime errors, rendered pixel metrics, and interaction state.
- Run stable Safari as required and Safari Technology Preview as non-blocking.
- Keep secrets, personal profiles, and normal browsing data out of the runner;
  SafariDriver's isolated automation window is sufficient.

**Definition of done**

- Stable Safari 26+ on macOS 26 Apple Silicon passes the package-consumer test
  over HTTPS with no experimental feature flag.
- WebDriver performs mouse orbit/pan, ordinary wheel zoom, keyboard reset,
  resize, screenshot, and disposal, and verifies camera/pixel change after each
  relevant action. Native trackpad two-finger scroll/inertial-wheel behavior is
  not inferred from synthesized wheel input and is closed by SAF-04's physical
  checklist.
- Run two separate lifecycle sequences against the same viewer fixture:
  1. thirty visibility cycles, each focusing a second same-origin tab long
     enough to observe `visibilitychange: hidden`, then refocusing the viewer
     and observing `visible`;
  2. thirty navigation cycles to a same-origin lifecycle-away page followed by
     `history.back()`. Every cycle must record `pagehide.persisted === true`
     when leaving the viewer and `pageshow.persisted === true` when returning;
     a normal reload or a `persisted === false` navigation does not count and
     fails the BFCache sequence. Run one separately labeled hard-reload control
     that requires `pageshow.persisted === false` so cold initialization cannot
     be confused with restore.
  Both sequences retain a working surface and do not duplicate the runtime,
  controller, observer, or pending RAF.
- The exact Safari/macOS/hardware/commit metadata and logs are retained.
- Safari Technology Preview failure warns but does not rewrite stable support.

## SAF-04 — Handle Safari Layout, Trackpad, And Lifecycle Edge Cases

**Priority:** P1; code/preflight is implementable, physical trackpad execution
is `LAB_INFRA_BLOCKED` until `browser-lab-infrastructure-readiness`

**Task definition**

Validate the DOM behavior most likely to diverge in Safari without introducing
non-standard gesture APIs.

**Necessary code changes**

- Exercise Pointer Events, pointer capture, `pointercancel`, right-button
  context menu suppression, wheel/trackpad zoom, and keyboard focus in real
  Safari.
- Add `crates/forge3d-web/tests/manual/safari-trackpad.md` for physical
  two-finger scrolling, inertial wheel termination, page-scroll isolation, and
  mandatory `SESSION_CHALLENGE_VISIBLE` evidence. Desktop trackpad pinch is
  explicitly outside the v1 viewer-input contract: Safari may apply its normal
  page/browser gesture, and Forge3D neither intercepts nor claims it as viewer
  zoom. Reuse INF-05's promoted manual session, signer, commit/hash, and
  evidence validation fields. Execute it only with `FW-TRACKPAD-01`, Apple Magic
  Trackpad (USB-C, 2024), model A3120, attached to `FW-MAC-M2-01`: pair/charge
  through a direct USB-C-to-USB-C cable without a hub, then perform acceptance
  gestures over Bluetooth. Capture the installed trackpad firmware, Bluetooth
  state/transport, battery state, and direct USB topology; never capture the
  serial number.
- Keep `touch-action: none` in the shared controls implementation; do not depend
  on or attach Safari `gesturestart`/`gesturechange`. Add a regression test that
  the viewer owns zero Gesture Event listeners before and after disposal.
- Use the shared ResizeObserver fallback path when
  `devicePixelContentBoxSize` is unavailable.
- Test fractional DPR, browser zoom, canvas entering/leaving `display:none`,
  and a zero-sized parent.
- Test `pagehide`/`pageshow` and BFCache restore. The BFCache case requires
  `pagehide.persisted === true` and `pageshow.persisted === true`; a
  non-persisted reload is a separate control and cannot satisfy it. Recreate
  only on actual `DEVICE_LOST`, not every navigation lifecycle event.
- Restore prior canvas inline styles and tabindex exactly on disposal.

**Definition of done**

- Trackpad two-finger scroll over the focused canvas produces wheel input,
  changes viewer zoom, terminates cleanly after inertial events, and does not
  scroll the page; the page scrolls normally outside the canvas. Trackpad pinch
  is not a required or claimed viewer control.
- The Safari trackpad checklist is signed against the exact commit, tarball
  SHA-256, `FW-MAC-M2-01`, `FW-TRACKPAD-01`, trackpad model/firmware,
  Bluetooth transport, direct USB topology, manual-session run/job, and visible
  media challenge; SafariDriver input alone cannot satisfy this criterion.
- Pointer capture continues a drag outside the canvas and always releases.
- A hidden or zero-sized canvas submits no frames and recovers after layout
  returns.
- Thirty true BFCache returns (`pageshow.persisted === true`) each have one
  observer, one input-controller set, and at most one pending RAF. Any
  `persisted === false` return fails this criterion rather than being counted as
  a restore.
- No WebKit-specific Gesture Event is attached or required for core
  interaction.

## SAF-05 — Promote A Narrow, Verified Safari Support Row

**Priority:** P1; P2 for older macOS/Intel expansion

**Task definition**

Publish only the Safari configurations that pass the exact release commit.

**Necessary code changes**

- Update `crates/forge3d-web/docs/support-matrix.md`,
  `crates/forge3d-web/docs/browser-api.md`,
  `crates/forge3d-web/docs/release-checklist.md`, package/root README, package
  contract, and changelog.
- State the tested minimum Safari and macOS version, architecture, and whether
  older macOS is supported, best-effort, or unsupported.
- Add physical jobs for Safari on Sequoia/Sonoma and Intel Mac only when those
  configurations can run WebGPU without a preview flag.
- Keep Safari Technology Preview in an early-warning row.
- Link exact-head SafariDriver artifacts from the release record.

**Definition of done**

- The required support row is no broader than the physical matrix.
- Safari 26 on older macOS and Intel Mac remains `NOT_PROVEN` unless it passes
  every required behavior without flags.
- Playwright WebKit is not cited as Safari release proof.
- Stable Safari's required job and every shared gate are green at the same
  commit.

## Safari Plan Acceptance Matrix

| Surface | Required status |
|---|---|
| Playwright WebKit on macOS | `ENGINE_PASS`; preflight only |
| Safari stable 26+, macOS 26, Apple Silicon | `PHYSICAL_PASS` |
| Safari Technology Preview | P2 early warning |
| Safari 26+, macOS Sequoia/Sonoma | P2, `NOT_PROVEN` until physically passed |
| Safari, Intel Mac | P2, `NOT_PROVEN` until physically passed |

## Primary References

- <https://developer.apple.com/documentation/safari-release-notes/safari-26-release-notes>
- <https://webkit.org/blog/16993/news-from-wwdc25-web-technology-coming-this-fall-in-safari-26-beta/>
- <https://developer.apple.com/documentation/safari-developer-tools/webdriver/>
- <https://developer.apple.com/documentation/webkit/testing-with-webdriver-in-safari>
- <https://webkit.org/blog/6008/new-web-features-in-safari/>
- <https://playwright.dev/docs/browsers>
