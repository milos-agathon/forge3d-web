# Forge3D Interactive Viewer Plan: Firefox

Date: 2026-07-27
Prerequisite: [shared foundation](2026-07-27-forge3d-interactive-viewer-foundation.md)
Physical prerequisite:
[test infrastructure](2026-07-27-forge3d-interactive-viewer-test-infrastructure.md)

## Scope And Support Tiers

Firefox WebGPU availability is platform-specific:

- Windows release Firefox: enabled by default from Firefox 142.
- Apple Silicon macOS release Firefox: enabled by default from Firefox 147.
- Intel macOS and Linux: Nightly/experimental at planning time.

Accordingly, the first required Firefox support tier is Windows plus Apple
Silicon macOS. Linux and Intel macOS are compatibility probes, not shipping
support, until Mozilla enables them by default and Forge3D passes physical
release tests.

Firefox Android is handled by the mobile plan and is not implied by desktop
Firefox success.

## FFX-01 — Add A Firefox Engine Preflight Project

**Priority:** P1

**Task definition**

Run the complete browser suite in Playwright's patched Firefox build while
clearly separating it from branded Firefox evidence.

**Necessary code changes**

- Add `firefox-preflight` to `crates/forge3d-web/playwright.config.ts` with no
  Chromium flags.
- Install Playwright Firefox in CI and add
  `npm run test:browser:firefox-preflight`.
- Make browser diagnostics and test helpers engine-neutral.
- Use the default preference state for required-platform preflight. Define a
  separate `firefox-nightly-experimental` configuration only for Linux/Intel
  macOS probes where `dom.webgpu.enabled` is deliberately set.
- Label artifacts with the preference override and support level.

**Definition of done**

- All interactive/render/API behavior runs in Playwright Firefox.
- Default-enabled and preference-enabled runs cannot be confused.
- Required tests fail, rather than skip, on missing WebGPU.
- Playwright Firefox is described as `ENGINE_PASS`, not branded release proof.

## FFX-02 — Eliminate Gecko-Visible Validation And Error Blind Spots

**Priority:** P1

**Task definition**

Verify that Forge3D's core WebGPU subset, shader, surface, mapping, and error
handling are accepted by Gecko/wgpu without browser-specific source.

**Necessary code changes**

- Use the shared async shader/pipeline validation scope and uncaptured-error
  handler.
- Verify surface formats/alpha modes from capabilities rather than assuming
  Chromium ordering.
- Keep `Depth24Plus`, non-filterable `R32Float`, uniform alignment, and WGSL loop
  bounds within core WebGPU.
- Add regression coverage for `map_async` screenshot readback and explicit
  device polling under Firefox.
- Exercise fetch, AbortSignal, Blob/File/ArrayBuffer, CORS, and HTTP range paths
  in Firefox.
- If Firefox exposes a failure, reduce it to the smallest wgpu/WGSL case, make a
  standards-compliant cross-browser fix, and add that case to every engine lane.
  Do not add a Gecko user-agent branch.

**Definition of done**

- Terrain pipeline creation, render, camera update, resize, and screenshot
  produce no uncaptured validation error.
- Screenshot readback settles without a hang and returns a valid PNG.
- All byte-source adapters and stable error mappings match Chromium behavior.
- Any Firefox-motivated code change passes Chromium and WebKit preflight.
- No production code checks for `Firefox`, `Gecko`, or a user-agent string.

## FFX-03 — Add Branded Firefox WebDriver Acceptance

**Priority:** P1; physical execution is `LAB_INFRA_BLOCKED` until
`browser-lab-infrastructure-readiness`

**Task definition**

Test the shipping Firefox binary on platforms where WebGPU is enabled by
default.

**Necessary code changes**

- Add `crates/forge3d-web/tests/webdriver/firefox-viewer.mjs` using the pinned
  Selenium/geckodriver versions from INF-01.
- Register branded Firefox lane commands in INF-04's dispatch workflow using:
  - `FW-WIN-I12-01` / labels
    `[forge3d-web, hw-win-intel12, ${{ needs.promote.outputs.runner_nonce_label }}]`;
  - `FW-MAC-M2-01` / labels
    `[forge3d-web, hw-mac-m2, ${{ needs.promote.outputs.runner_nonce_label }}]`.
  These are INF-04 repository-level JIT runners. Their workflow selectors use
  only the three authorization-bound custom labels; any GitHub-generated
  read-only platform labels are non-authoritative. The promotion job, not
  dispatch input, supplies the unique `jit-<runner-nonce>` output.
- Download, hash-verify, and install FND-07/INF-03's packed npm artifact in a
  fresh consumer before running the shared interactive probe.
- Run Firefox Nightly on `FW-LNX-I12-01` and `FW-LNX-NV-01` as non-blocking
  jobs, recording the exact `dom.webgpu.enabled` override. Add Intel macOS only
  after an exact asset is added to the infrastructure matrix.
- Capture browser version, OS/architecture, adapter/limits, WebGPU preference
  state, runtime/pixel results, and exact commit.

**Definition of done**

- Branded stable Firefox passes on Windows and Apple Silicon macOS without
  changing `about:config`.
- Orbit, pan, wheel, pointer capture, keyboard, resize, visibility resume,
  terrain IO, screenshot, and disposal pass.
- Fifty create/render/dispose cycles finish with zero owned
  listener/observer/RAF/runtime diagnostic counts.
- Each required host runs FND-07's exact
  `forge3d-viewer-benchmark-v1` workload and retains its complete raw timing
  object. All 600 measured frames submit, none skip, the frame queue remains
  bounded, and nearest-rank p95 RAF interval is at most 50 ms under FND-07's
  no-trimming/throttle rules.
- Nightly/pref results remain clearly experimental.

## FFX-04 — Validate Firefox Input And Page Lifecycle

**Priority:** P1

**Task definition**

Prove Firefox-specific DOM event ordering does not leave controls stuck or
rendering after suspension.

**Necessary code changes**

- Add tests for pointer capture leaving the canvas, `lostpointercapture`,
  `pointercancel`, multi-button mouse transitions, and Shift+right-click.
- Ensure context-menu suppression is tied to a consumed gesture, because
  browser context-menu behavior can differ.
- Verify wheel `deltaMode` normalization for pixel, line, and page units before
  applying exponential zoom.
- Verify visibility, zero-size suspension, BFCache, and disposal.
- Keep keyboard handling canvas-scoped and test focus traversal before and after
  viewer disposal.

**Definition of done**

- Every accepted pointer reaches one terminal state and no active pointer
  survives cancellation or lost capture.
- Equivalent wheel gestures in different `deltaMode` units produce bounded,
  comparable zoom.
- Shift+right-click behavior does not corrupt the controller even if the browser
  opens its context menu.
- Hidden/BFCache-restored viewers resume once without duplicate resources.
- Canvas focus/tabindex and inline styles are restored exactly on dispose.

## FFX-05 — Promote Only Default-Enabled Firefox Platforms

**Priority:** P1 for Windows/Apple Silicon; P2 for Linux/Intel macOS

**Task definition**

Publish platform-qualified Firefox support, not a blanket browser claim.

**Necessary code changes**

- Add separate Windows, Apple Silicon macOS, Linux, and Intel macOS rows to
  `crates/forge3d-web/docs/support-matrix.md`.
- Update package/root README,
  `crates/forge3d-web/docs/release-checklist.md`,
  `crates/forge3d-web/docs/browser-api.md`, package contracts, and changelog.
- Make the stable WebDriver jobs release-blocking for supported platforms.
- Keep Nightly/pref jobs non-blocking and labeled experimental.
- Re-evaluate Linux/Intel macOS only after default browser enablement; rerun the
  full exact-head physical matrix before promotion.

**Definition of done**

- Windows and Apple Silicon rows cite exact stable-version test artifacts.
- Linux and Intel macOS are not called supported based on Nightly or a pref.
- The documentation explains that feature detection remains mandatory even on
  nominally supported platforms because hardware/driver blocklists can remove
  the adapter.
- Every shared gate and required branded Firefox job passes at the release
  commit.

## Firefox Plan Acceptance Matrix

| Surface | Required status |
|---|---|
| Playwright Firefox | `ENGINE_PASS`; preflight only |
| Branded Firefox stable, Windows 11 | `BRANDED_PASS` on hardware-backed runner |
| Branded Firefox stable, Apple Silicon macOS | `PHYSICAL_PASS` |
| Firefox Nightly, Linux with pref/default Nightly behavior | P2 experimental |
| Firefox Nightly, Intel macOS with pref | P2 experimental |
| Firefox release, Linux/Intel macOS | `NOT_PROVEN` until default-enabled and passed |

## Primary References

- <https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Experimental_features#webgpu_api>
- <https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/147>
- <https://playwright.dev/docs/browsers>
