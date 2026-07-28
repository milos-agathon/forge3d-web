# Forge3D Interactive Viewer Plan: Chrome, Chromium, And Edge

Date: 2026-07-27
Prerequisite: [shared foundation](2026-07-27-forge3d-interactive-viewer-foundation.md)
Physical prerequisite:
[test infrastructure](2026-07-27-forge3d-interactive-viewer-test-infrastructure.md)

## Scope And Support Tiers

This plan covers:

- Google Chrome on Apple Silicon macOS as the required first Mac tier. Intel Mac
  remains P2/`NOT_PROVEN` until a separate physical asset is added and passed.
- Google Chrome/Chromium on Linux configurations where WebGPU is enabled by
  default and a hardware adapter is available.
- Branded Microsoft Edge, with Windows and macOS as required branded lanes.
- Edge on Linux as an expansion lane until physically verified.

It does not treat `--enable-unsafe-webgpu`, `--ignore-gpu-blocklist`, software
adapters, or browser flags as end-user support.
It also does not infer support for Brave, Opera, Vivaldi, Electron, or other
Chromium embedders from Chrome/Edge results.

Chrome's Linux rollout is not universal:

- Intel Gen12+ support began rolling out in Chrome 144.
- Modern NVIDIA drivers (2024-05 or later) on Wayland were added in Chrome
  147/148.
- AMD/Linux is `NOT_PROVEN` by those platform announcements and remains P2.

The package's version floor must be the oldest browser that passes Forge3D's
exact release suite, not the browser's first WebGPU version.

## CHR-01 — Replace The Flagged Single Project With Explicit Chromium Projects

**Priority:** P1

**Task definition**

Make browser and OS configuration explicit so a D3D11 flag cannot contaminate
macOS, Linux, or Edge results.

**Necessary code changes**

- In `crates/forge3d-web/playwright.config.ts`, remove the global
  `launchOptions.args`.
- Define these projects:
  - `chromium-preflight`: Playwright Chromium; flags allowed only when the
    project name and test artifact say `preflight`;
  - `chrome-stable`: `channel: "chrome"` with no unsafe WebGPU flags;
  - `edge-stable`: `channel: "msedge"` with no unsafe WebGPU flags.
- Add explicit package scripts:
  `test:browser:chromium`, `test:browser:chrome`, and
  `test:browser:edge`.
- Keep the default `test:browser` fast and hermetic by selecting only
  `chromium-preflight`.
- Extend diagnostics to report browser version, user agent, secure context,
  adapter acquisition, adapter limits, runtime creation, and whether launch
  flags were present.

**Definition of done**

- The normal Chrome and Edge scripts contain no unsafe WebGPU, GPU blocklist,
  Vulkan-enable, or ANGLE-forcing flag.
- macOS and Linux projects receive no D3D11 argument.
- The preflight project is visibly excluded from branded support claims.
- A required Chrome/Edge run fails if adapter acquisition fails.
- Test output makes it impossible to confuse Chromium, Chrome, and Edge.

## CHR-02 — Normalize Adapter Selection And Chromium Lifecycle Behavior

**Priority:** P1

**Task definition**

Remove assumptions that can prevent an otherwise compatible Chromium browser
from acquiring or retaining an adapter.

**Necessary code changes**

- Add explicit `"none"` to `RuntimeOptions` in
  `crates/forge3d-web/src/inputs.rs` and map it to
  `wgpu::PowerPreference::None`.
- Preserve `RuntimeOptions::default()` and direct
  `Forge3DRuntime.create(canvas)` as `HighPerformance` for low-level
  compatibility. `Forge3DViewer.create()` passes explicit `"none"` only when
  `options.runtime?.powerPreference` is omitted.
- Preserve `low-power` and `high-performance` when the caller explicitly asks
  for them; do not silently retry a caller's explicit policy with another GPU.
- Implement shared device-loss and uncaptured-error handling from FND-01.
- Ensure `render()` skips occluded frames and resumes on visibility without
  converting occlusion to `REQUEST_CANCELLED`.
- Add a Chrome regression that backgrounds/restores the page and continues
  orbiting without recreating the viewer unless an actual `DEVICE_LOST` occurs.
- Keep WebGPU feature selection at the core baseline: no Chromium-only WGSL
  extension or optional adapter feature may enter the terrain path.

**Definition of done**

- Default viewer creation does not request a discrete/high-performance adapter.
- Direct low-level omission still maps to high-performance. Viewer omission,
  viewer explicit high-performance, and viewer explicit low-power each map to
  the exact expected wgpu value in contract tests.
- The viewer survives 30 hide/show cycles with no duplicate RAF, listener,
  runtime, or canvas-surface owner.
- A ten-second interaction run produces no uncaptured WebGPU validation errors.
- Chrome, Chromium, and Edge execute identical shader and viewer code.

## CHR-03 — Add Hardware-Backed Chrome macOS And Linux Lanes

**Priority:** P1; physical execution is `LAB_INFRA_BLOCKED` until
`browser-lab-infrastructure-readiness`

**Task definition**

Prove normal-configuration Chrome on the actual OS/GPU combinations included in
the support matrix.

**Necessary code changes**

- After INF-00..06 are code-complete and
  `browser-lab-infrastructure-readiness` reports `LAB_INFRA_READY`, run the
  enumerated Chrome lane commands
  in INF-04's manually dispatched `.github/workflows/browser-hardware.yml`.
  `.github/workflows/web.yml` may report or request a post-merge hardware run,
  but its PR jobs never target a hardware runner or call a reusable hardware
  workflow. Use only these promotion-controlled label lists, with no
  `self-hosted` or other default label:
  - `FW-MAC-M2-01`:
    `[forge3d-web, hw-mac-m2, ${{ needs.promote.outputs.runner_nonce_label }}]`;
  - `FW-LNX-I12-01`:
    `[forge3d-web, hw-linux-intel12, ${{ needs.promote.outputs.runner_nonce_label }}]`;
  - `FW-LNX-NV-01`:
    `[forge3d-web, hw-linux-rtx3070, ${{ needs.promote.outputs.runner_nonce_label }}]`.
  INF-04 requires the third value to match `jit-<runner-nonce>` and registers
  the matching repository-level ephemeral runner only after promotion.
- Download and install FND-07/INF-03's single packed npm artifact; verify and
  record its SHA-256 before launching Chrome.
- Run the installed shipping stable Chrome as required. Use Chrome Beta as a
  non-blocking early-warning lane. A minimum-version claim requires a separate
  pinned branded binary in
  `crates/forge3d-web/tests/infrastructure/browser-policy.json`; it is never
  inferred from the current channel.
- Record `chrome://gpu`-equivalent capability diagnostics where automation
  permits, but make the actual Forge3D render/interaction probe the acceptance
  signal.
- Keep Intel Mac and AMD/Linux as non-blocking probes only after exact assets
  are added to the checked infrastructure matrix.

**Definition of done**

- Every required job runs the packed npm artifact at the exact release commit
  through INF-03's publicly trusted HTTPS route.
- No required job uses an unsafe WebGPU flag or software adapter.
- Orbit, pan, wheel zoom, pointer capture, keyboard controls, auto-resize,
  visibility resume, terrain source loading, screenshot, and disposal pass.
- Each required host runs FND-07's exact
  `forge3d-viewer-benchmark-v1` workload and retains its complete raw timing
  object. All 600 measured frames submit, none skip, the frame queue remains
  bounded, and nearest-rank p95 RAF interval is at most 50 ms under FND-07's
  no-trimming/throttle rules.
- Fifty create/render/dispose cycles end with zero values in the owned
  listener/observer/RAF/runtime diagnostics.
- Intel Mac and AMD/Linux remain documented `NOT_PROVEN` until exact assets meet
  the same gate.

## CHR-04 — Add Branded Edge Acceptance

**Priority:** P1 for Windows/macOS; P2 for Linux; physical execution is
`LAB_INFRA_BLOCKED` until `browser-lab-infrastructure-readiness`

**Task definition**

Verify the package in shipping Microsoft Edge rather than inferring support
from Chromium.

**Necessary code changes**

- Register branded Edge lane commands in INF-04's dispatch workflow using only
  `FW-WIN-I12-01` and `FW-MAC-M2-01`.
- Install/use Playwright's `msedge` channel with no unsafe flags and run
  FND-07's packed-consumer assertion payload.
- Add an Edge enterprise-policy diagnostic case that reports
  `WEBGPU_ADAPTER_UNAVAILABLE` without suggesting a browser-flag bypass.
- Run the same package-consumer HTML and assertion payload as Chrome.
- Add an Edge Linux job only after an exact asset is added to
  `crates/forge3d-web/tests/infrastructure/hardware-matrix.json` and branded
  Edge, Wayland, and a default hardware WebGPU adapter attest successfully.
- Update `crates/forge3d-web/docs/support-matrix.md` with separate Edge rows; do
  not write "Chromium-based, therefore supported."

**Definition of done**

- Edge stable on Windows 11 and supported macOS passes without flags.
- The exact Edge version and adapter availability appear in retained artifacts.
- A policy-disabled or acceleration-disabled adapter produces the documented
  unsupported UI and stable error; Forge3D does not advise bypassing policy.
- Edge Linux is either physically passed and listed with its exact constraints,
  or remains best-effort/`NOT_PROVEN`.

## CHR-05 — Promote Chromium Support Without Weakening Existing Gates

**Priority:** P1

**Task definition**

Change documentation and release policy only after all required Chromium lanes
pass at the same commit.

**Necessary code changes**

- Update `crates/forge3d-web/docs/support-matrix.md`,
  `crates/forge3d-web/docs/release-checklist.md`, package README, and root
  README.
- Replace the current blanket "Chrome/Chromium on macOS/Linux: Best effort"
  language with exact passed configurations and an explicit Linux exclusion
  list.
- Keep `chromium-preflight` in CI for fast regression coverage, but make
  branded/hardware jobs the support gate.
- Add package contract assertions for the new matrix and commands.
- Add a changelog entry naming the exact support tiers and remaining
  `NOT_PROVEN` configurations.

**Definition of done**

- Documentation lists browser versions, OS/architecture/GPU constraints, and
  whether each lane is required or best-effort.
- No support row relies on a run with unsafe flags.
- Chrome Linux is not described as universal.
- Release artifacts link to all required exact-head runs.
- Existing API, package, Rust, WASM, terrain, screenshot, and IO gates remain
  green.

## Chromium Plan Acceptance Matrix

| Surface | Required status |
|---|---|
| Playwright Chromium | `ENGINE_PASS`; preflight only |
| Chrome stable, macOS Apple Silicon | `PHYSICAL_PASS` |
| Chrome stable, macOS Intel | P2, `NOT_PROVEN` until an exact asset is added and passed |
| Chrome stable, Linux Intel Gen12+ Wayland | `PHYSICAL_PASS` |
| Chrome stable, Linux modern NVIDIA Wayland | `PHYSICAL_PASS` |
| Chrome stable, Linux AMD | P2, `NOT_PROVEN` until passed |
| Edge stable, Windows 11 | `BRANDED_PASS` on hardware-backed runner |
| Edge stable, macOS | `BRANDED_PASS` on physical Mac |
| Edge stable, Linux | P2, `NOT_PROVEN` until passed |

## Primary References

- <https://developer.chrome.com/docs/web-platform/webgpu/troubleshooting-tips>
- <https://developer.chrome.com/blog/new-in-webgpu-144>
- <https://developer.chrome.com/blog/new-in-webgpu-147-148>
- <https://playwright.dev/docs/browsers>
