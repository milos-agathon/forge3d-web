# W21 verification

Scope: M08 offline licensing/gates, M09 benchmark/memory diagnostics and E07
PNG/array/display utilities. Renderer configuration remains W02-owned and
datasets remain W14-owned. No subagents were used.

## Inspected native contracts

The exact native commit is recorded in
[native-contract.json](../tests/fixtures/w21/native-contract.json). The retained
[source files](../tests/fixtures/w21/native/) include `_license.py`, Rust's
license verifier, `test_license.py`, `test_pro_gating.py`, `_png.py`,
`test_png_io_fallback.py`, `bench.py`, `device_diagnostics.py` and `perf_sanity.py`.
Each file has a SHA-256 assertion. The tests use signed native-development
license fixtures, native date/grace behavior, independent PNG fixtures and
independent known statistical expectations. No Python or Node rendering is
used to execute the browser outcomes.

The baseline includes W19 and does not contain the separate W20 implementation.
Map plate/SVG/PDF feature names are available in the gate catalog; those APIs
remain owned by W20. Existing building imports, styles and bundles are wired
to the gates, including MapScene building preflight and product adapters.

## Local verification on 2026-10-15

The full unit suite passed 1,721 tests in 78 files. The combined W15/W18/W19/W21
Chromium source/dist regression run passed all 86 cases, including all eight
W21 cases. API/type declarations, documentation links, W00 parity, browser
harness and package contracts passed. Infrastructure passed 627 tests with its
one existing Unix cross-UID test skipped on Windows. The npm advisory response
reported no advisories for either added noble dependency.

Raw unit/package logs and the advisory response are retained locally under
`test-results/w21-*`. The installed gate writes its own raw JSON, runtime
revision, tarball/WASM digests and outcome; inspect
`test-results/w21-package-consumer.json` and
`test-results/w21-installed-playwright.json` after running it.

## Verification commands

Run from `crates/forge3d-web`:

```text
npm run build:wasm
npm run build:ts
npm run prepare-dist
npm run test:unit
npm run test:api
npm run verify:parity
npm run test:package
npm run test:w21
npm run test:package-consumer:w21
```

On Windows, set CARGO_TARGET_DIR to `C:\devin-target\forge3d-web`.
The installed gate requires a clean committed tree, rebuilds WASM/TS, packs and
installs the npm tarball into a temporary consumer, typechecks imports using
only installed declarations, and serves only installed files with a restrictive
same-origin CSP. It runs the dist W21 tests and retains package/WASM digests
and raw Playwright evidence under `test-results/w21-*`. CI runs this gate and
uploads its reports.

The browser suite checks offline WebCrypto/noble verification, malformed and
expired keys, grace warnings, real OPFS persistence, product gating, exact PNG
round trips including hidden RGB at zero alpha, ImageData/Canvas adapters,
module-worker PNG use, HTMLImageElement/DOM fallback, interactive controls and
real renderer readback benchmarks. Renderer output must cover the entire test
region before its benchmark report is accepted.

These checks are functional Chromium engine preflight on the local adapter.
They do not satisfy physical Chrome/Firefox/Safari qualification or W00
hardware performance budgets. Browser licensing is validity and client API
gating, not tamper-resistant DRM. Sensitive server/data entitlements remain
server-side. See [API contracts and limitations](utilities.md).
