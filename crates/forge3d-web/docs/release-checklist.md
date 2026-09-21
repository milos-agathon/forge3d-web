# Forge3D Web Release Checklist

Run this checklist from the repository root unless a command explicitly changes directory. It gates the incremental browser WebGPU/WASM package and, once every manifest row closes, the complete functional-parity release.

## Interactive Viewer Release Blocker

The FND-01..FND-07 shared viewer foundation is implemented substantially, but
its contract stage remains `verification-incomplete` pending portability,
physical device-loss, and current clean exact-HEAD package evidence. It must
not be promoted as support for a browser family while
`package.json#forge3d.interactiveViewer.releaseReady` is `false`. That flag may
change only after the required branded and physical exact-head release matrix
passes. This blocker does not withdraw the existing low-level
`Forge3DRuntime` MVP.

INF-00 code completion is also separate from live laboratory readiness.
`tests/infrastructure/repository-trust-policy.json`,
`hardware-matrix.json`, `browser-policy.json`, and
`runner-transient-path-policy.json` intentionally remain in pending states
until the administrator and physical-controller steps in
`docs/browser-lab-runbook.md` are evidenced. A pending policy must fail closed;
it cannot be treated as a skipped or successful physical gate.

## Functional-Parity Truthfulness Blocker

Browser/npm/WASM is the delivery format, not a functional exclusion. Release
documentation must keep these categories separate:

| Category | Required treatment |
|---|---|
| Delivery-format exclusion | Name the unshipped packaging/process mechanism and map its observable outcomes to E01-E07 browser equivalents. |
| Tombstone or product boundary | Link the explicit [composite manifest](https://github.com/milos-agathon/forge3d/blob/main/docs/parity/forge3d-composite-baseline.json) or plan ledger entry; never present it as an implemented capability. |
| Feature gap | Link every current gap to its R/C/T/P/V/G/M row and W00-W24 task; never relabel an open row as excluded. |
| Browser support evidence | Keep a lane `NOT_PROVEN` until its required attested physical evidence passes. |

The [exhaustive parity matrix](https://github.com/milos-agathon/forge3d/blob/main/docs/superpowers/plans/2026-06-04-forge3d-browser-webgpu-wasm-runtime.md#exhaustive-parity-matrix)
and [tombstone ledger](https://github.com/milos-agathon/forge3d/blob/main/docs/superpowers/plans/2026-06-04-forge3d-browser-webgpu-wasm-runtime.md#truthfulness-lifecycle-and-tombstone-ledger)
are authoritative. A release cannot claim complete functional parity while
`npm run verify:parity` reports an open capability/constraint, plan drift,
unmapped inventory, or missing evidence.

## Clean Setup

```powershell
cd crates/forge3d-web
npm ci
cd ../..
```

## Rust And Wasm Gates

```powershell
cargo fmt --all -- --check
cargo clippy -p forge3d-core --target wasm32-unknown-unknown --no-default-features -- -D warnings
cargo clippy -p forge3d-web --target wasm32-unknown-unknown -- -D warnings
cargo test -p forge3d-core --features gpu
cargo test -p forge3d-web
cargo check -p forge3d-core --target wasm32-unknown-unknown --no-default-features
cargo check -p forge3d-web --target wasm32-unknown-unknown
$env:PATH = "$pwd\crates\forge3d-web\node_modules\.bin;$env:PATH"
.\crates\forge3d-web\node_modules\.bin\wasm-pack.cmd build crates/forge3d-web --target web
```

## Web Package Gates

```powershell
cd crates/forge3d-web
npm run verify:parity
npm run typecheck
npm run build
npm run test:unit
npm run test:api
npm run test:infrastructure
npm run test:package
$env:FORGE3D_PACKAGE_GATE_MODE = "required"
npm run test:package-consumer
$env:FORGE3D_SOURCE_BENCHMARK_MODE = "required"
$env:FORGE3D_WEBGPU_REQUIRED = "1"
npm run test:browser:chrome
npm pack --dry-run
cd ../..
```

`npm run test:package` includes the release-hardening contract and the dry-run
package artifact contract. The dry run must include `dist/index.js`,
`dist/forge3d_web.js`, `dist/forge3d_web_bg.wasm`, `types/index.d.ts`,
`README.md`, `LICENSE`, and `LICENSE-APACHE`.

The package-consumer gate builds and packs the real tarball, records its
SHA-256, installs that absolute `.tgz` into a fresh temporary consumer, and
serves `examples/test-interactive-viewer.html` from the consumer.
The release gate refuses to attribute a dirty worktree to `HEAD`. Its complete
validated record and package association are retained under
`test-results/browser-gate/` (or `FORGE3D_EVIDENCE_DIR`) and uploaded by CI.
In required mode the gate defaults to installed branded Chrome, records
`installed-tarball-chrome-stable` with browser/channel `chrome`, and passes no
unsafe-WebGPU, GPU-blocklist, Vulkan-enable, or ANGLE-forcing arguments. It
verifies a reported, non-fallback WebGPU adapter and independently observed
drag/wheel/touch/keyboard interaction,
unsupported-browser UI, screenshot readback, resize, and leak-free disposal.
Before disposal, the source and installed-package gates run the same 30-cycle
visibility lifecycle exercise. Non-headed execution records an explicitly
labelled deterministic synthetic visibility mode. With `FORGE3D_HEADED=1`,
Chromium projects use a second real tab and require actual document visibility
transitions. The Playwright Firefox and WebKit preflights use the explicitly
labelled synthetic lifecycle because those automated engine lanes do not yield
real background-tab visibility; this says nothing about branded or physical
Firefox or shipping Safari behavior. The result records whether actual document
transitions occurred, is retained separately from the unchanged v3 browser
evidence record, and is never sufficient by itself for support promotion.
It then runs the frozen benchmark and passes the complete exact-tarball evidence
record through the shared fail-closed validator. It is not an HTTP-only asset
smoke test.
The frozen v1 benchmark remains exactly 600 samples applied on direct,
consecutive harness animation-frame callbacks; its raw duration is a
performance measurement, not the CHR-02 ten-second clock. A separate shared
observation continuously cycles the frozen absolute trace on animation frames
for at least 10,000 ms of actual viewer interaction/render activity. It
observes normalized `viewer.onError` codes and uncaptured WebGPU validation
errors reported through browser console or page errors, and fails on a short
run or any observed error. Source Playwright attaches that explicitly
non-promotional observation, while the installed-package gate retains it as a
sibling outside the unchanged v3 browser evidence record. Probe observations
remain non-promotional and probe lanes still omit the benchmark.
Hosted CI sets `FORGE3D_PACKAGE_GATE_MODE=probe` and
`FORGE3D_BROWSER_CHANNEL=bundled` because its virtual Windows runner may expose
only a fallback adapter. That lane uses unsafe WebGPU plus Windows D3D11,
records `installed-tarball-chromium-preflight` as Playwright Chromium with
`PROBE`, omits the performance benchmark, and cannot satisfy release promotion.
Required release execution defaults to `FORGE3D_PACKAGE_GATE_MODE=required`
and branded Chrome; required mode rejects the bundled channel and still fails
closed on fallback hardware.
Hosted CI likewise sets `FORGE3D_SOURCE_BENCHMARK_MODE=probe`: the source
browser job explicitly runs `test:browser:chromium`. The default
`test:browser` command aliases that same bundled Playwright Chromium project,
which uses unsafe-WebGPU preflight flags and the D3D11 ANGLE flag on Windows.
That flagged configuration is preflight/`ENGINE_PASS` evidence only; it cannot
establish branded Chrome or Edge support. The hosted probe persists
schema-valid environment and interaction evidence but does not run or label
software-renderer timing as a real-GPU benchmark.
The sibling `Playwright WebKit Engine Preflight` job runs on hosted macOS with
literal job-level `continue-on-error: true`, installs only Playwright WebKit,
builds the browser package, and runs the complete `test:browser:webkit` suite
with `FORGE3D_WEBGPU_REQUIRED=1` and
`FORGE3D_SOURCE_BENCHMARK_MODE=probe`. It passes no Chromium launch arguments.
The raw test step always writes a structured JSON report. Only raw suite success
that agrees with the complete expected inventory uploads
`forge3d-web-playwright-webkit-ENGINE_PASS`. A nonzero run may leave the optional
check green only when every expected test executes and fails at exactly the
missing-`navigator.gpu` capability boundary; the job summary then says
`NOT_PROVEN` and no WebKit artifact is uploaded. Missing, malformed, zero-test,
incomplete, extra, mixed, unexpected, or raw-result-disagreeing reports fail the
optional check. This engine preflight is not shipping Safari, branded-browser,
exact-tarball, or physical GPU evidence. Safari remains unsupported/`NOT_PROVEN`.

For SAF-03, accept only `forge3d-saf03-safari-acceptance-v1` from the required
`safari-macos-m2` lane. The record must retain per-action camera/frame/pixel
evidence, native and viewer PNG digests with decoded terrain pixels, exactly 30
ordered real visibility cycles, exactly 30 ordered persisted-true BFCache
cycles, the separate persisted-false hard reload, exact ownership/disposal,
and the untrimmed FND-07 benchmark. Revalidate the full object at lane, matrix
source, hosted finalizer, and merge boundaries. A legacy Safari smoke, WebKit
preflight, STP result, or missing/uncertain cleanup cannot replace stable proof.
`test:browser:chrome` and `test:browser:edge` select the installed branded
channels without unsafe WebGPU, GPU-blocklist, Vulkan-enable, or ANGLE-forcing
flags. Their normal configurations use required evidence mode and fail when
`navigator.gpu` or adapter acquisition is unavailable. The required branded
source execution runs all 600 measured samples and rejects fallback adapters;
these command definitions do not claim that either branded run has passed.
The GitHub-hosted Apple-Silicon source-browser job separately runs
`test:browser:firefox-preflight` in Playwright's patched Firefox with default
preferences and no Chromium launch flags. Both its diagnostics probe and full
suite run headed with `FORGE3D_HEADED=1`, set `FORGE3D_WEBGPU_REQUIRED=1`, and
`FORGE3D_SOURCE_BENCHMARK_MODE=probe`: required render behavior fails when
WebGPU or adapter acquisition is unavailable, while performance remains probe
evidence. CI uploads that record immediately under a Firefox-preflight,
`ENGINE_PASS`, default-preferences artifact name. It is not branded Firefox,
physical-browser, exact npm-tarball, or release-support evidence and does not
change Firefox's `Unsupported` support status.
Release browser evidence must validate against
`tests/browser/browser-evidence.schema.json`; a required lane may not pass with
an unavailable adapter, a probe-only result, or a source-WASM digest in place
of an exact npm-tarball digest.
The required branded source-browser benchmark writes and attaches its complete
evidence record under Playwright `test-results/`; CI uploads the separate
flagged Chromium preflight record.

## Physical Evidence And Publication

Code completion does not unlock physical lanes. First publish and verify the
fixed non-support laboratory canary, then run
`browser-lab-infrastructure-readiness` with the exact package, four host
canaries, generic manual canary, intake, hardware job, and canary release IDs.
For the infrastructure-only manual canary, pass the successful
`submit-browser-manual-evidence.yml` run as `manualCanaryRunId`; pass its
controller-signed session's Browser Hardware job separately as
`manualHardwareJobId`. A Browser Hardware workflow run is not a substitute for
the authenticated submission run.
Only an attested `LAB_INFRA_READY` record with the current
`labInfrastructureDigest` unlocks browser and product-manual lanes.
The selected host runs and their physical inventory must be current within the
checked 24-hour acceptance window. The Mac host canary must contain six
controller-signed Appium device route probes for the exact nonce-bound package;
host-side or emulated route checks do not satisfy this gate.

After every required physical row runs, dispatch
`browser-hardware-release-readiness` with the same target and laboratory run
plus the canonical sorted evidence-run ID array. It must produce exactly 24
closed keys, pass the prior-head, package-hash, and missing-row negative
controls, and emit attested `RELEASE_MATRIX_READY`. Only that record may feed
`publish-web-release.yml`.

The publisher persists every finalized digest-checked record under a unique
filename, then generates exactly one `chromium-support.md` before closing the
candidate and publication-preflight inventories. The generator revalidates the
attested `RELEASE_MATRIX_READY` manifest, exact target/package/laboratory
bindings, all 24 unique keys, safe launch arguments, six primary configured
Chromium rows, and conditional Edge Linux rows. It writes the observed
four-component branded browser versions, OS builds and displays; configured
CPU/GPU/architecture constraints; and exact run-attempt links. The draft and
immutable published GitHub Release API bodies must each equal those source
bytes exactly. The file must also be present exactly once in the candidate
manifest, draft download, immutable download, and postpublication verification.

Individual package, controller, hardware, manual, readiness, and
post-publication verification artifacts are retained in GitHub Actions for 90
days. The immutable GitHub Release receives byte-identical package and evidence
assets, their checksum-bearing manifest, and the complete matrix. Keep failed
draft manual intakes for retry and audit. Delete an intake/tag only after every
selected media byte is copied to the final draft, SHA-256 checked, the release
is published once, and `gh release verify` plus every
`gh release verify-asset` command succeeds.

Rerun from the earliest invalid boundary:

- Repository policy, workflow, package, or laboratory-digest drift requires a
  new package, canaries, and laboratory-readiness record.
- A failed, expired, wrong-SHA, wrong-package, or missing physical record
  requires that exact lane to run again; do not reuse or edit its artifact.
- A publication preflight older than 30 minutes requires a new dispatch.
- A failed publication that did not publish may reuse intact source evidence
  through a fresh preflight. Never mutate a published immutable release.

A quarantined or maintenance asset remains required and blocks publication.
Do not silently drop its row or substitute another host, GPU, device, browser,
pen, trackpad, controller, tunnel, or package. Any substitution requires a
reviewed matrix and policy change, new `labInfrastructureDigest`, fresh
canaries, and a new complete physical matrix. Narrowing the published support
matrix is a separate reviewed product decision, not an infrastructure skip.

## Release Notes

- Confirm `CHANGELOG.md` has an `Unreleased` entry for browser package release
  hardening.
- Confirm `docs/support-matrix.md` states evidence-bound browser status, product
  boundaries, tracked feature gaps, MIME, CORS/Range, and cache requirements.
- Confirm every documented current feature gap links to its parity row and task.
- Confirm delivery-format exclusions and tombstones are not described as
  functional-parity exclusions.
- Confirm `README.md` links this checklist and the support matrix.
- Confirm `docs/browser-lab-runbook.md` and every checked infrastructure
  policy agree on the repository, trust epoch, controller keys, runner
  version, archive digests, protocol versions, and provisioning state.
- Confirm no browser family is described as supported without the required
  attested physical evidence.
