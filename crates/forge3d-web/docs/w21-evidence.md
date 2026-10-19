# W21 review verification

Review scope: the W21 section and M08/M09/E07 requirements at `c88f0699`,
applied to the W21 implementation at `f0c34be8`. Work was performed in the
`codex/w21-utilities` worktree without subagents.

W21 is **Partial**. M08 remains **E**: the map plate, SVG and PDF names in
`PRO_FEATURES` are not integrated or tested product gates. W20 is now present
after merging main, but its license gate integration remains outstanding. Existing
building, style and bundle gates are covered. M09 is **I** with cold timing,
baseline comparison and FND-07 consumption of the public operation schema.
E07 remains **I**. These statuses are recorded in the plan matrix, W21 ledger,
W21 code status and composite parity baseline.

## Native provenance and observed regressions

The native reference is `1f4084af428dc699bdcd108b029736cb73903926`.
[native-contract.json](https://github.com/milos-agathon/forge3d-web/blob/d5cf3b578d7a946e2ca4008c42537380889537b3/crates/forge3d-web/tests/fixtures/w21/native-contract.json) records
SHA-256 assertions for the retained [native sources](https://github.com/milos-agathon/forge3d-web/tree/d5cf3b578d7a946e2ca4008c42537380889537b3/crates/forge3d-web/tests/fixtures/w21/native/),
including licensing, PNG helpers, benchmarks, diagnostics and `perf_sanity`.
No native private signing key was copied. Issuer tests generate Ed25519
keypairs at test time with the existing noble dependency.

Regression checks cover the following outcomes:

- The one-time public issuer configuration controls the package singleton's
  actual gates. All four development-signed fixtures are rejected under a
  generated issuer, and every integrated gated entrypoint remains blocked.
  A key signed by that generated issuer succeeds. Configuration locks after
  configuration or any nonempty key attempt, including pending/failed attempts,
  and stays locked after clear.
- Local calendar expiry includes the entire expiry day and fourteen grace
  days. Controlled interleaved verification proves that a newer failed key
  preserves an older pending valid key, while clear and a newer successful key
  win. Every integrated product entrypoint is exercised with missing, expired
  and grace keys; grace must succeed and warn. Tests clear the setup key first.
  Follow-up interleavings also prove that a storage load verifies its valid or
  forged stored key when a verification started before the load completes
  during the storage read. Clears and successful requests issued after the
  read starts still win; a failed newer request does not cancel the load.
  Missing/expired URL cases cover all five network-reading product loaders,
  including `loadStyleLayers` with a GeoJSON URL inside a style specification.
  All ten cases failed under temporary read-before-gate faults, which were
  removed before validation.
- `Frame.toPng` encodes 4097x4096 pixels with compression `none`, and
  `encodePng` accepts an offset Uint8ClampedArray byte view. The image-array
  pixel limit remains enforced. Exact RGBA8 tests include hidden RGB at zero
  alpha.
- Source and dist browser tests load PNGs with trailing bytes after IEND,
  tRNS longer than PLTE, and 4097x4097 one-bit dimensions through `loadImage`'s
  compatible browser fallback. `pngToArray` rejects these same fixtures. The
  retained negative-control browser run failed all six compatibility cases
  against the original loader and also failed the missing FND-07 companion.
- Readback/screenshot operations capture once per operation without an extra
  render. Real session statistics were observed to remain unchanged by capture;
  benchmark `rendererStats` is therefore null. Renderer configuration is the
  actual target config, an explicit requested config, or null. The duplicate
  `scene_rgba` operation is removed; native `scene_rgba` maps to `renderer_rgba`
  over the caller's committed scene.
- The first operation is reported separately as `coldMs` and excluded from
  steady samples. Baseline p95 comparison accepts the default 50% increase and
  reports `baselineP95Regression` above it. Independent clock-controlled tests
  check cold/warm/sample accounting, thresholds and a zero baseline.

FND-07's existing source benchmark test now attaches a separate public
`BenchmarkResult` after validating its original v1 evidence. The companion
uses the frozen terrain and manifest and measures real viewer screenshots;
it checks image dimensions and rejects uniform output. The requested W21
browser run covers this companion. The existing source evidence test passed in
`FORGE3D_SOURCE_BENCHMARK_MODE=probe`. A separate Chromium preflight test then
ran the complete frozen 120-warmup/600-sample schedule and the public companion
(1 passed, 0 failed). This supplements the engine evidence without claiming
physical-browser qualification. No frozen manifest, trace, golden, determinism hash or W00
dependency lock changed. The parity plan digest changed with the requested
status corrections.

## Local validation on 2026-10-15

Commands ran from `crates/forge3d-web` with
`CARGO_TARGET_DIR=C:\devin-target\forge3d-web`. Raw logs below are local,
ignored files relative to the repository root under `.cache/w21-review/`.

| Gate | Observed result | Raw log |
| --- | --- | --- |
| `build:wasm` + `build:ts` + `prepare-dist` | All three commands passed | `followup-build.log` |
| `test:unit` | 1780 passed, 0 failed; 81 files | `followup-unit.log` |
| `test:api` | Typechecks, API snapshot and emitted-facade checks passed | `followup-api.log` |
| `verify:parity` | 15 passed, 0 failed; manifest verifier reported no violations | `followup-parity.log` |
| `test:package` | Docs 27 passed; browser harness 118 passed; infrastructure 627 passed, 1 existing Unix cross-UID skip on Windows; 0 failed; package/release scripts passed | `followup-package.log` |
| Requested W15/W18/W19/W21 Chromium preflight | 95 passed, 0 failed, including 17 W21 cases | `followup-browser.log` |
| License tests, `TZ=Pacific/Kiritimati` | 68 passed, 0 failed | `followup-tz-kiritimati.log` |
| License tests, `TZ=America/Los_Angeles` | 68 passed, 0 failed | `followup-tz-los-angeles.log` |
| Additional source FND-07 test, probe mode | 1 passed, 0 failed | `fnd07.log` |
| Complete frozen FND-07 schedule and public companion, Chromium preflight | 1 passed, 0 failed | `followup-full-fnd07-rerun.log` |

After merging main's W20 commit `676022b2`, the combined build and API checks
passed, all 1920 unit tests passed in 88 files, parity passed 15/15, and the
package gate passed 29 documentation, 118 browser-harness and 627 infrastructure
tests with its one existing Windows-inapplicable skip. Raw logs are
`merge-build.log`, `merge-api.log`, `merge-unit-rerun.log`, `merge-parity.log`
and `merge-package.log`. The first unit run alongside build/package work hit
the existing worker lifecycle test's five-second timeout (1919 passed, 1 failed;
`merge-unit.log`); the isolated full rerun passed without changing that test.

PR CI exposed a missing W15 installed-consumer fixture asset: the example now
imports `example-license.js`, but its copied example directory omitted that
module. The original installed W15 script reproduced the startup timeout
locally (`ci-w15-red.log`). The harness now copies the helper from the installed
package, explicitly provisions the signed test key and asserts active license
status before running its existing geometry/building checks. The full installed
W15 check passed with no page errors or external requests (`ci-w15-green.log`).
This corrects the fixture without bypassing product gates.

An initial Kiritimati run hit the default five-second cold-module-loading
timeout while other tests ran concurrently (52 passed, 1 failed). Its raw log
is retained as `tz-kiritimati-timeout.log`. The two cold issuer tests now allow
fifteen seconds; both complete timezone reruns above passed. The browser
negative-control log is retained as `red-browser.log`.
The storage-load regressions failed before the follow-up fix (2 failed,
10 passed) in `followup-red-load.log`, then all 68 license tests passed in
`followup-green-license.log`. The ten URL mutation failures are retained in
`followup-red-url-gates.log`.
The first attempt to launch the supplemental full-schedule test served the
temporary config directory instead of the package directory; it was stopped
before any test ran. `followup-full-fnd07.log` retains that setup log. The
corrected local config and test are retained in `.cache/w21-review/`, together
with `full-fnd07-playwright.json` and its scheduling/operation attachment.

The exact requested browser command was:

```text
npx playwright test tests/playwright/w15_geometry.spec.ts tests/playwright/w18_mapscene.spec.ts tests/playwright/w19_style_bundle.spec.ts tests/playwright/w21_utilities.spec.ts --project=chromium-preflight
```

## Installed consumer and limits of this evidence

`npm run test:package-consumer:w21` passed all 8 installed-tarball Chromium
cases under the same-origin CSP on review-fix commit
`4bf561f5462dd0acf51429921c92b0e0c165b5d0` (0 failed). The raw log is
`.cache/w21-review/installed-initial.log`; its revision-bound result and full
browser report are retained alongside it as `installed-initial-result.json`
and `installed-initial-playwright.json`. This run predates the subsequent
merge of W20 from main.

The gate also passed all 8 cases (0 failed) on the combined revision
`0b97e886b7dc54907eded78c74fc56ee0ae05846`. The committed
[installed evidence](w21-installed-evidence.json) records its actual revision,
tarball/WASM digests and Playwright totals. Raw log/result/browser records are
`.cache/w21-review/installed-merged.log`, `installed-merged-result.json` and
`installed-merged-playwright.json`. The following evidence-only commit does not
change the tested runtime; PR CI reruns the gate on the PR revision.

The gate requires a clean committed tree, rebuilds WASM/TS, installs the tarball into
a temporary consumer, typechecks installed declarations and exercises dist
under a same-origin CSP. It writes the actual revision, tarball/WASM digests,
outcome and raw browser results to `test-results/w21-package-consumer.json`
and `test-results/w21-installed-playwright.json`. Consult those records and
the run's raw log for the installed outcome; it is not implied by the local
source/dist results above.

The checks above establish functional Chromium engine preflight on the local
adapter. Physical Chrome/Firefox/Safari qualification and W00 hardware
performance budgets were not run. Browser
licensing provides offline validity, expiry/grace and client API gating, not
tamper-resistant DRM. See [API contracts and limitations](utilities.md).
