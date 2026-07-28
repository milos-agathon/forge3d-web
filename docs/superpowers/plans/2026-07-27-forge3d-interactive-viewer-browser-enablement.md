# Forge3D Interactive Viewer Browser Enablement

Date: 2026-07-27
Repository baseline: `ffba491` (`main`)
Package: `@forge3d/web` `1.26.3`

## Purpose

This is the controlling index for enabling an interactive Forge3D terrain
viewer in:

1. Chrome/Chromium on macOS and Linux, plus branded Microsoft Edge.
2. Safari.
3. Firefox.
4. Mobile browsers.

The implementation is split into one shared foundation plan, one executable
physical-test infrastructure plan, and four browser-family plans:

- [Shared viewer and runtime foundation](2026-07-27-forge3d-interactive-viewer-foundation.md)
- [Physical test infrastructure](2026-07-27-forge3d-interactive-viewer-test-infrastructure.md)
- [Chrome/Chromium and Edge](2026-07-27-forge3d-interactive-viewer-chromium.md)
- [Safari](2026-07-27-forge3d-interactive-viewer-safari.md)
- [Firefox](2026-07-27-forge3d-interactive-viewer-firefox.md)
- [Mobile browsers](2026-07-27-forge3d-interactive-viewer-mobile.md)

The foundation and infrastructure plans are prerequisites, not additional
browser implementations. Each plan has task definitions, priorities, required
code changes, and definitions of done. The set contains exactly 37 tasks:
8 foundation, 7 infrastructure, 5 Chromium/Edge, 5 Safari, 5 Firefox, and
7 mobile tasks.

## Evidence-Bound Current State

The repository already contains a browser WebGPU/WASM renderer, but not an
interactive viewer.

| Area | Current implementation | Consequence |
|---|---|---|
| Rendering | `Forge3DRuntime.render()` presents one frame on demand. | There is no render scheduler or interaction-driven invalidation. |
| Camera | `setCamera()` accepts a complete camera value. | There is no orbit, pan, zoom, pointer, touch, wheel, or keyboard controller. |
| Resize | `resize()` requires an explicit positive CSS size and DPR. | There is no `ResizeObserver`, DPR-change handling, zero-size suspension, or pixel budget. |
| Lifecycle | `dispose()` releases owned Rust handles. | There is no listener/observer cleanup layer, visibility handling, BFCache handling, or device-loss recovery. |
| WebGPU backend | Rust creates `wgpu::Backends::BROWSER_WEBGPU` and a main-thread `HTMLCanvasElement` surface. | WebGL, `OffscreenCanvas`, and worker rendering are not fallback paths. |
| GPU limits | Device creation requests `wgpu::Limits::downlevel_webgl2_defaults()`. | Terrain/canvas inputs are not currently checked against adapter limits before allocation. |
| Terrain memory | A JavaScript `Float32Array` is copied to Rust, cloned during validation, expanded to a full vertex/index mesh, and uploaded. | Large heightmaps can cause avoidable memory spikes, especially on mobile. |
| Surface loss | `Outdated` and `Lost` both call `configure()` on the existing surface. | This conflicts with wgpu 29: `Lost` requires a newly created surface, capability re-query, and possibly a format-dependent pipeline rebuild. |
| Errors | The stable error union lacks device-loss, insecure-context, WASM-load, and internal-error codes. | Several materially different failures can be reported as `WEBGPU_UNAVAILABLE`, or escape normalization. |
| Browser tests | Playwright has one `chrome` project and global Chromium-only flags: `--enable-unsafe-webgpu --use-angle=d3d11`. | The present test lane does not prove normal end-user Chrome, macOS, Linux, Edge, Safari, Firefox, or mobile support. |
| CI | The browser job runs on `windows-latest`. | No exact-head physical or hardware-backed proof exists for the requested surfaces. |
| Repository trust | Live GitHub state reports `main.protected: false`, enforcement `off`, and no required checks. | Reachability from current `main` is not trusted promotion evidence until INF-00 creates and proves the protected-branch epoch. |
| Package consumer | The Vite example depends on `file:../..`. | It proves a workspace install, not installation of the packed release tarball. |
| Physical lab | No self-hosted labels, device inventory, trusted mobile HTTPS route, driver policy, or retained manual evidence exists. | The physical definitions of done for CHR-03/04, SAF-02/03/04, FFX-03, and MOB-02/03/04/05/06 are `LAB_INFRA_BLOCKED` until `browser-lab-infrastructure-readiness` passes. |

Therefore, current interactive support for every requested browser family is
`NOT_PROVEN`. The existing one-frame Chrome/Windows lane is useful regression
evidence but is not a substitute for any plan's definition of done.

## Support Contract To Implement

### Required product behavior

- Mouse: left-drag orbit, middle/right-drag pan, wheel/trackpad zoom.
- Touch/pen: one-pointer orbit; two-pointer pan and pinch zoom.
- Keyboard while the canvas has focus: orbit, pan, zoom, and reset.
- At most one render submission per animation frame, with no continuous loop
  while idle.
- Automatic canvas resize with DPR handling and explicit pixel ceilings.
- Clean suspension for hidden, zero-sized, and backgrounded views.
- Deterministic cleanup on `dispose()`.
- A clear unsupported-state result when a secure WebGPU adapter cannot be
  acquired.
- Device and surface loss reported distinctly. A lost surface is recreated on
  the existing device; an actually lost device may recreate the runtime once
  when replayable viewer state is available.

### Explicit non-goals

- No WebGL fallback.
- No user-agent sniffing to select renderer behavior.
- No `OffscreenCanvas`, worker renderer, or threaded WASM in the first release.
- No native/Python viewer parity.
- No new COPC/EPT/LAZ, 3D Tiles, COG, or raster-streaming scope.
- No claim that a Playwright-emulated phone is physical mobile WebGPU proof.

## Priority Model

| Priority | Meaning |
|---|---|
| P0 | Shared release blocker. No browser-family plan may be marked complete without it. |
| P1 | Release blocker for the named browser family or support tier. |
| P2 | Hardening or expansion lane. It must remain documented as best-effort or `NOT_PROVEN` until complete. |

Priorities express necessity, not implementation order within a pull request.

## Support Evidence Levels

| Level | Required evidence |
|---|---|
| `CODE_COMPLETE` | Code and contract tests are implemented and reviewed. |
| `LAB_INFRA_READY` | `browser-lab-infrastructure-readiness` proves protected-main trust, the exact controller/ephemeral-runner/device/accessory inventory, host locks, secure package route, generic headed/device/manual-session canaries, and release mechanics. It unlocks physical execution but is not browser support evidence. |
| `ENGINE_PASS` | Automated tests pass in Chromium, Playwright Firefox, or Playwright WebKit. This is preflight evidence only. |
| `BRANDED_PASS` | Tests pass in the shipping branded desktop browser without experimental or unsafe WebGPU flags. |
| `PHYSICAL_PASS` | Tests pass on the declared physical GPU/device/OS/browser matrix. |
| `RELEASE_MATRIX_READY` | `browser-hardware-release-readiness` verifies every required exact-head physical/manual lane against the current laboratory digest. It unlocks publication. |
| `SUPPORTED` | `CODE_COMPLETE` plus `RELEASE_MATRIX_READY` and the support-matrix/documentation update. |

Do not promote a surface from `NOT_PROVEN` or best-effort to supported based on
feature detection, an emulated viewport, a different browser engine, a prior
commit, or a run with unsafe WebGPU flags.

## Browser Reality At Planning Time

These facts constrain what code can honestly claim:

- Chrome documents WebGPU as available by default from Chrome 113 on macOS,
  ChromeOS, and Windows, and from Chrome 121 on supported Android 12+ devices.
  Forge3D's supported-version floor must still be set by its own release tests,
  not by those first-availability versions.
- Chrome's Linux rollout is hardware-specific. Chrome 144 began with Intel
  Gen12+; Chrome 147/148 added modern NVIDIA drivers on Wayland. AMD/Linux is
  not proven by those announcements and remains an expansion lane here.
- Safari 26 added WebGPU. The required desktop Safari lane in this plan is
  Safari 26+ on macOS 26; Safari 26 on older macOS releases stays a separate
  compatibility lane until physically verified.
- Firefox currently enables WebGPU by default on Windows and on Apple Silicon
  macOS, while Linux and Intel macOS remain Nightly/experimental surfaces.
- Playwright's WebKit and Firefox binaries are patched test browsers, not
  shipping Safari or branded Firefox. They are valuable preflight lanes but
  cannot supply `BRANDED_PASS`.
- WebGPU is a secure-context API. Production and physical-device acceptance
  must use HTTPS; loopback HTTP is acceptable only for local desktop tests.

## Dependency Order

```text
Shared foundation FND-00..FND-07
  ├── owns API, runtime, controls, scheduler, budgets, recovery
  └── owns only shared fixtures/schema/tarball consumer in FND-07

Physical infrastructure INF-00..INF-06
  └── owns repository-level ephemeral runners, lab controllers, devices,
      HTTPS, headed adapter attestation and evidence

Browser plans own all projects and browser drivers:
  ├── Chromium/Edge CHR-01..CHR-05
  ├── Safari SAF-01..SAF-05
  ├── Firefox FFX-01..FFX-05
  └── Mobile MOB-01..MOB-07
        ├── Chrome Android also depends on completed Chromium behavior
        └── iOS/iPadOS Safari also depends on completed Safari behavior

Physical tasks CHR-03/04, SAF-02/03/04, FFX-03, MOB-02/03/04/05/06
  ├── execution requires relevant FND code, INF-00..06 code, and
  │   browser-lab-infrastructure-readiness
  └── their completed matrix feeds browser-hardware-release-readiness
```

Recommended delivery sequence:

1. Land FND-00's complete public contract before any downstream public API work.
2. Implement FND-01..07 while provisioning INF-00..06 in parallel; FND-07 stops
   at shared fixtures/schema/tarball consumption.
3. Let each browser plan add its own Playwright project or branded driver.
4. Run Safari and Firefox conformance work independently; do not encode
   browser-name branches unless a reduced reproduction proves they are needed.
5. Run physical acceptance only after `LAB_INFRA_READY`; evaluate
   `browser-hardware-release-readiness` from those results, then publish support
   only after `RELEASE_MATRIX_READY`.

## Requirement Traceability

| Requirement/gap | Owning tasks | Browser acceptance |
|---|---|---|
| Public viewer contract | FND-00 | CHR-05, SAF-05, FFX-05, MOB-07 |
| Recoverable WebGPU/WASM errors | FND-01 | CHR-02, SAF-02, FFX-02, MOB-01 |
| Deterministic orbit/pan/zoom math | FND-02 | Every browser interaction lane |
| Mouse/touch/pen/wheel/keyboard | FND-03 | CHR-03/04, SAF-03/04, FFX-03/04, MOB-02/05/06 |
| RAF coalescing, resize, DPR, visibility, BFCache | FND-04 | CHR-02/03, SAF-04, FFX-04, MOB-03 |
| GPU and memory ceilings | FND-05 | CHR-03, SAF-02, FFX-02, MOB-04 |
| One-time device recovery | FND-06 | Every required physical lane |
| Shared assertions, evidence schema, packed consumer | FND-07 | Every browser project/driver |
| Runner/device/HTTPS/hardware/manual evidence | INF-00..06 | CHR-03/04, SAF-02/03/04, FFX-03, MOB-02/03/04/05/06 |
| Protected-main trust root and two-stage readiness | INF-00, INF-04, INF-06 | Every physical execution and support-publication decision |
| Browser project/driver ownership | CHR-01, SAF-01/03, FFX-01/03, MOB-05/06 | The task that declares that browser |
| Platform-qualified published support | Documentation tasks | CHR-05, SAF-05, FFX-05, MOB-07 |

## Global Release Gate

All of the following are required before any browser-family support claim:

- Existing Rust, WASM, TypeScript, API snapshot, package, and npm dry-run gates
  remain green.
- The release fixture installs the `npm pack` tarball in a fresh consumer, uses
  public `Forge3DViewer`, records the tarball SHA-256, and contains no workspace
  `file:` dependency.
- Interactive tests prove orbit, pan, zoom, resize, hidden/visible resume,
  disposal, error classification, and terrain rendering.
- Browser projects do not inherit launch flags meant for another engine or OS.
- Required lanes fail rather than skip when `navigator.gpu`, adapter acquisition,
  shader/pipeline creation, or presentation fails.
- Optional/probe lanes report unsupported configurations without converting
  them into release success.
- `crates/forge3d-web/docs/support-matrix.md`,
  `crates/forge3d-web/docs/browser-api.md`,
  `crates/forge3d-web/docs/release-checklist.md`, package/root README,
  declarations, and API snapshots agree with the exact implementation.
- Every physical lane passes INF-00..06 and uses the exact named asset, headed
  one-job ephemeral runner, hardware adapter, trusted HTTPS route, package
  SHA-256, and evidence schema.
- `browser-lab-infrastructure-readiness` passes before any browser/manual
  physical lane executes, and `browser-hardware-release-readiness` passes only
  after the complete exact-head matrix; neither check is allowed to depend on
  itself.
- Every support claim identifies the exact browser, OS, architecture/GPU tier,
  browser configuration, commit, and test artifact.

## Implementation Readiness

- FND-00..07 and the code/emulated portions of all browser tasks are ready to
  implement in the declared dependency order.
- Eleven tasks have a physical definition of done: CHR-03, CHR-04, SAF-02,
  SAF-03, SAF-04, FFX-03, MOB-02, MOB-03, MOB-04, MOB-05, and MOB-06. Those
  physical portions are deliberately `LAB_INFRA_BLOCKED`, not underspecified:
  their
  exact repository-level ephemeral provider, controllers, assets/accessory,
  labels, HTTPS/package route, automation, manual checks, authenticated
  provenance, and retention exit gate are defined in INF-00..06.
- Code, schemas, emulation, and non-physical automation for those eleven tasks
  may be implemented before readiness. Their physical acceptance steps may not
  execute until `browser-lab-infrastructure-readiness` reports
  `LAB_INFRA_READY`, may not be marked complete without their own passing
  evidence, and may not support publication until
  `browser-hardware-release-readiness` reports `RELEASE_MATRIX_READY`. Absence
  of hardware cannot be converted to a skip or a support pass.

## Blocking-Review Closure

| Review finding | Binding resolution |
|---|---|
| Lost surface incorrectly reconfigured | FND-01 recreates the surface, re-queries capabilities, rebuilds a format-dependent pipeline when needed, and keeps device recreation separate. |
| Public contract incomplete | FND-00 freezes the exact runtime/viewer types, members, defaults, callbacks, invalidation, concurrency, failure, recovery, diagnostics, and disposal behavior. |
| FND/browser ownership duplicated | FND-07 owns only shared fixtures/schema/tarball consumption; CHR, SAF, FFX, and MOB tasks own their projects, drivers, and jobs. |
| Physical infrastructure absent | INF-00..06 fix the personal-repository-compatible ephemeral provider, controllers, inventory, labels, device/accessory models, headed adapter attestation, HTTPS route, package transfer, browser policy, automation, manual evidence, and retention. |
| Terrain copy precedes limits | FND-05 requires checked metadata/adapter limits before `Float32Array.copy_to`, then move-based validation. |
| Ignored HTTP Range ambiguous | FND-05 accepts `200` only at offset zero under the exact payload ceiling and rejects ignored nonzero-offset ranges. |
| Wrong WASM MIME not guaranteed to fail | FND-01 explicitly fetches and validates the media type, supports a testable URL, and clears failed bridge initialization from cache. |
| WASM singleton race ambiguous | FND-01 stores a schema-v1 coordinator under one stable `Symbol.for` key on the Window `globalThis`; duplicate facade bundles share the same record, different URLs reject, and only an owning rejection clears the record. |
| Power default unresolved | CHR-02 preserves omitted low-level `high-performance`; the viewer explicitly requests `none` only when its own caller omits a preference. |
| Test/docs/package mechanics incomplete | FND-02 adds Vitest and `test:unit`; all documentation paths are package-qualified; owned counters make cleanup measurable; FND-07 installs the actual tarball in a fresh consumer. |
| Self-hosted runner trust boundary unsafe | INF-04 accepts only a reviewed base-repository SHA reachable from protected `main`, builds/attests it on GitHub-hosted infrastructure, and registers an authorization-bound, one-job JIT repository runner with the exact three custom routing labels only for the nonce-bound queued job; GitHub-generated read-only platform labels may coexist, and hardware executes only the verified artifact without a source checkout. |
| Physical task gate undercounted | The master and INF plan enumerate all eleven tasks whose definitions of done require real browsers, gestures, lifecycle cycles, or device budgets. |
| CORS origin and route unspecified | INF-03 fixes separate application/asset HTTPS origins, a 128-bit path nonce, exact allow/deny headers, and range behavior. |
| Manual evidence forgeable | INF-05 binds generated evidence to the authenticated workflow actor, independent environment approval, media digests, and a verifiable GitHub artifact attestation. |
| Release immutability assumed | INF-06 requires the repository setting, draft-first asset upload, publish-once sequencing, and CLI verification of the release and every asset. |
| Fallback adapter probe obsolete | INF-02 uses `adapter.info.isFallbackAdapter` and fails closed when neither that boolean nor unequivocal browser-to-host corroboration is available. |
| Pen and Safari lifecycle evidence incomplete | INF-00 adds two exact pen baselines; MOB-02 requires them, and SAF-03 requires separate 30-cycle visibility and BFCache sequences. |
| Personal repository cannot use an organization runner group | INF-00/04 bind the current `milos-agathon/forge3d-web` owner and replace the infeasible group with broker-generated, authorization-bound repository JIT runners; no runner exists at rest. |
| `workflow_dispatch` cannot upload checklist media | INF-05 adds a protected draft-release intake, authenticated `gh release upload`, numeric asset-ID submission, API/uploader/digest validation, attested final bundling, and delayed intake deletion. |
| Attestation permissions and release trust incomplete | Every `actions/attest` job declares `artifact-metadata: write`; INF-06 gives only the protected publisher `contents: write`, validates default-branch/exact-SHA readiness before mutation, and separates publisher/approver from implementation actors. |
| Mac mini has no declared trackpad | INF-00 adds `FW-TRACKPAD-01`, the USB-C 2024 Magic Trackpad model A3120, with exact direct-USB/Bluetooth topology and firmware-bound evidence in INF-05/SAF-04. |
| Performance workload and timing math undefined | FND-07 freezes the byte-hashed 512x512 terrain, 320x320 CSS/640x640 backing canvas, 720-sample absolute camera trace, warm-up, raw 601-timestamp schema, nearest-rank p95, FPS formula, and no-trimming/throttle policy consumed by CHR-03, FFX-03, MOB-05, and MOB-06. |
| Safari/mobile BFCache could pass through reload | SAF-03/04 and MOB-03/06 require `pageshow.persisted === true` for every counted restore and keep `persisted === false` hard reload as a separate control. |
| Physical implementation wording contradictory | Only physical execution is gated by `LAB_INFRA_READY`; code, schemas, emulation, and non-physical automation may be implemented earlier, while publication separately requires `RELEASE_MATRIX_READY`. |
| Protected-main trust root absent | INF-00 bootstraps two stable required checks, creates and live-verifies exact PR/review/status/admin/force-push/deletion protection, proves it with a canary PR, and pins a post-protection `trustEpochSha`; INF-04 rejects pre-epoch or policy-drifted commits. |
| Infrastructure readiness circular | `browser-lab-infrastructure-readiness` uses only the generic `infrastructure-canary` lane and a separate non-support lab-canary publisher to unlock physical execution; the later `browser-hardware-release-readiness` consumes physical browser results and alone unlocks support publication. |
| Manual evidence lacks a physical session | INF-05 adds a host-reserved promoted manual lane, controller-signed and GitHub-hosted-attested session inventory, exact package/route/browser/device binding, a 20-minute capture window, and a challenge carried into media/submission. |
| Device concurrency can overlap on the Mac host | INF-04 maps every attachment to its owning host and uses one cross-run host concurrency group plus an OS-level controller lock; all six mobile assets, trackpad, and desktop Safari serialize on `FW-MAC-M2-01`. |
| Safari trackpad pinch has no permitted event path | SAF-04 removes desktop trackpad pinch from the v1 viewer contract, retains two-finger scroll/inertial-wheel zoom, and proves that no Safari Gesture Event listener is attached. |
| Controller cannot observe promotion outputs | A sibling GitHub-hosted authorization job discovers the queued hardware job and attests `runner-authorization.json`; the controller verifies that record and API-visible run/job fields instead of inferring hidden outputs/inputs. |
| Hardware-job permissions unspecified | INF-04 grants the ephemeral job only `actions: read`, `contents: read`, and `attestations: read`, denies every other permission, and forbids checkout/offline attestation. |
| Page singleton implemented only per module | FND-01 uses a versioned coordinator in a stable `globalThis` symbol slot and includes a two-bundle, one-Window negative/positive contract fixture. |
| Runner-registration permission can also alter repository policy | INF-00 removes repository Administration permission from every controller and workflow, isolates it in an explicit registration-broker trust root, exposes only authorization-derived JIT issuance and exact-runner cleanup operations over mTLS, and requires independent live-policy verification before either mutation. |
| Raw registration token is not bound to the authorized job | INF-00/04 forbid the registration-token endpoint; the broker derives the exact runner name, custom labels, group, and `_work` folder, returns only one opaque JIT configuration, and the controller can start only `run.sh`/`run.cmd --jitconfig`. |
| Runner cleanup/read authority missing | INF-00/04 keep exact-ID deletion in the write-authorized broker with an issuance ledger and watchdog; INF-05 polls runner absence with a short-lived `Administration: read` trust-observer token confined to the GitHub-hosted finalizer. |
| Trust-observer environment cannot coexist with consumer jobs | INF-00 defines an attested, 30-minute, exact-SHA/run/attempt/operation/consumer-bound trust observation; observer jobs expose only the action-produced artifact ID, fixed name, artifact digest, and content SHA-256, and every package-build/manual/lab/readiness/release consumer downloads by exact REST artifact ID with no name fallback or App secret. |
| Privileged workflow action tags are mutable | INF-00 adds a reviewed workflow-actions lock, requires a full 40-hex commit for every `uses:` line in required/privileged workflows, forbids local/container-action exceptions there, digest-pins job/service images, rejects tags/branches statically, and enables GitHub's SHA-pinning policy when available. |
| Whole runner-tree hash changes during legitimate work | INF-00/04 replace tree equality with a canonical immutable archive-entry manifest, explicitly isolate `_diag`, `_work`, and exact reviewed transient paths, and fail on any missing/modified distribution entry or unknown executable/symlink/path. |
| Online runner can remain idle while its job stays queued | INF-00/04 add `online_unassigned`, a 90-second assignment deadline, signed local-listener stop, independent queued/non-busy proof, exact-ID deletion, exact bound-run cancellation, watchdog fallback, and positive/negative lifecycle tests. |

## Primary References

- Chrome WebGPU troubleshooting and platform prerequisites:
  <https://developer.chrome.com/docs/web-platform/webgpu/troubleshooting-tips>
- Chrome 144 Linux rollout:
  <https://developer.chrome.com/blog/new-in-webgpu-144>
- Chrome 147/148 NVIDIA Linux rollout:
  <https://developer.chrome.com/blog/new-in-webgpu-147-148>
- Chrome 121 Android rollout:
  <https://developer.chrome.com/blog/new-in-webgpu-121>
- Safari 26 WebGPU announcement:
  <https://webkit.org/blog/16993/news-from-wwdc25-web-technology-coming-this-fall-in-safari-26-beta/>
- Safari 26 release notes:
  <https://developer.apple.com/documentation/safari-release-notes/safari-26-release-notes>
- Firefox WebGPU platform status:
  <https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Experimental_features#webgpu_api>
- Firefox 147 Apple Silicon enablement:
  <https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/147>
- Playwright browser-binary distinctions:
  <https://playwright.dev/docs/browsers>
- WebGPU specification:
  <https://www.w3.org/TR/webgpu/>
- Pointer Events specification:
  <https://www.w3.org/TR/pointerevents/>
- Resize Observer specification:
  <https://www.w3.org/TR/resize-observer/>
- wgpu 29 current-surface recovery:
  <https://docs.rs/wgpu/29.0.3/wgpu/enum.CurrentSurfaceTexture.html>
