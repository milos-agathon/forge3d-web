# W18 review corrections

The review's six defects are repaired on `codex/w18-mapscene`. M01/M02a remain
implemented; M02b conforms by retaining diagnostics. W16 is accepted;
MapScene integration of G02-G04 is not yet implemented and tested.
All MapScene point-cloud and tiles3d recipes block before resource fetching or
GPU work, including nonempty points and explicit supported intent. Standalone
W16 APIs retain their separate scope.

The [assertion ledger](../../crates/forge3d-web/docs/w18-native-test-coverage.json)
audits 106 native definitions with named web tests, assertion scope, browser
adaptations and deferred assertions. It does not claim 106 full ports. The four
omitted suites have explicit plan ownership; seven W19 cases remain deferred.
Actual MapScene tests now check building texture IDs/fallback, native layer types,
cache/LOD/instancing details, deterministic no-op blocking, known/unknown memory
and bottleneck ordering. Seven semantic documentation tests cover the API,
emitted codes, support taxonomy, ownership and product boundaries.

Raster preflight and preparation share merged options, including inherited terrain
overlays and the eight-visible-layer limit. Camera and nested setting typos and
unknown lighting presets produce user diagnostics before preparation/rendering.
Raised resource/recipe limits apply during construction, validation, serialization
and JSON replay. A 70,560,000-byte inline DEM exercises the real default-limit
failure; bounded base64 scanning also prevents a decoder stack overflow.
Browser defaults (64 MiB, 128 layers, 16 megapixels) are distinguished from R07's
512 MiB memory policy.

Two additional failures found during verification were corrected: imagery remains
in the executed-layer record after overlay refactoring; label rejection warnings
are emitted once. Validation refusals preserve their report instead of adding a
generic render error, while runtime cancellation/sink/device failures still clear
success and release owners.

Observed on 2026-10-12 in the implementation worktree:

| Gate | Result |
|---|---|
| Native Git blob audit | 27 files, 106 definitions; exact bytes match a55911f and 1f4084a |
| TypeScript build, dist preparation, public API/types | Passed |
| Complete unit suite | 71 files, 1,249 tests passed |
| W18 source/dist browser suite | 30 passed; no failures or skips |
| Shared W16 source/dist browser suite | 14 passed; optional ten-minute acceptance soak skipped |
| Aggregate package gate | Passed; 22 documentation, 118 browser-harness, 627 infrastructure passes; one Unix-UID case skipped on Windows |
| Parity | 15 tests passed; 6,531 mappings; zero untracked/duplicate/unresolved entries |
| Clean installed W18 consumer | Strict consumer compiled; 15 browser tests passed; no failures/skips/flaky tests |

The [native audit](w18-runs/review-native-audit.json) records each exact file hash.
The clean installed gate ran at implementation revision
`5c6f79a9bb406eb45103b6f661a9714d19de14d2`. Its
[raw browser report](w18-runs/review-installed-playwright.json) and
[consumer record](w18-runs/review-package-consumer.json) bind tarball SHA-256
`a8745af1266acbe33b48c0c28e0b67aeb408dc1dfd059eab5c71cda7033b6fe8`,
independently recomputed after the run. Runtime modules and assets came exclusively
from the separately installed tarball. The
[observed CLI results](w18-runs/review-observations.json) record the final source/dist
and unit completions; their full raw reports were not captured. Subsequent commits
only record repository evidence and do not change the tested runtime.
The old [verification record](w18-verification.md) and original raw runs remain
historical evidence; their point/tiles promotion and broad coverage claim are
superseded. Browser observations are local flagged Chromium preflight evidence,
not physical W00 or cross-browser qualification. No subagents were used.


## Completion after accepted W16 (2026-10-13)

Merged accepted `origin/main` (`e8fc61d`) in `cd23ddc`. M02b keeps main's exact
required outcome, W18's added native test references and status `C`. Plan and
runtime wording now identify the missing MapScene integration of G02-G04 as the
blocker. All current W18 support text uses the MapScene integration reason. Point-cloud and tiles3d retain their exact blocking codes.

`map-validation.ts` now uses shared dataset field checks and one finite/range
scan, without building percentile statistics. `prepareMapLayers` still builds
the complete `TerrainDataset` once and shares it across label plans. Existing
field-check ordering, nodata handling and diagnostic messages are preserved.
The additive million-sample spy regression proves zero full builds across
repeated validate/review calls and one full build per preparation; further cases
check exact diagnostic equivalence and mutated/replaced resource data. No
runtime limits, thresholds or goldens changed. Repository build/preparation
scripts produced the assets used by the gates; no generated runtime file was
edited by hand. Parity hashes were regenerated with
`scripts/generate-parity-inventory.mjs`; existing W18 test/evidence metadata was
preserved after generation without changing any hash by hand.

Same Node v24.4.0/Windows x64/AMD Ryzen 9 5900X workload, four consecutive
`validate()` calls per size, deterministic heights `(index % 4096) * 0.25`;
construction is outside the timer. Means in milliseconds:

| DEM | Before | After | Full dataset builds across four calls |
|---|---:|---:|---|
| 1024 x 1024 | 840.738 | 142.291 | 4 -> 0 |
| 3000 x 3000 | 7587.514 | 1166.076 | 4 -> 0 |
| 4200 x 4200 | 14787.403 | 1987.072 | 4 -> 0 |

Validation still copies recipe resources and performs linear finite checks.
The [observations](w18-runs/finish-20261013-observations.json) retain all individual
measurements, the exact workload, changed files, development checks and gate
counts. The [CLI transcript](w18-runs/finish-20261013-cli.txt) retains raw requested
gate output. All requested gates ran:

| Gate | Result |
|---|---|
| `npm run build:ts` then `npm run prepare-dist` then `npm run test:api` | Passed |
| `npm run test:unit` (full) | 71 files, 1262 tests passed |
| `npm run test:w18` | 101 unit, 7 documentation, 30 source/dist browser tests passed; no skips |
| `npm run test:w16` | 67 unit, 14 source/dist browser tests passed; existing opt-in ten-minute soak skipped |
| `npm run test:package` | Passed; 22 documentation, 118 browser-harness, 627 infrastructure passes; existing real Unix UID case skipped on Windows |
| `npm run verify:parity` | 15 tests, 6531 mappings; zero untracked/duplicate/unresolved entries |
| `npm run test:package-consumer:w18`, after commit from a clean tree | Strict consumer compiled; 15 browser tests passed; no failures, skips or flaky tests |

The clean installed run is bound to the new implementation commit
`6e4ce2d6590b850a1fdddf3d1b71e5a41bad047d` and tarball SHA-256
`ecd16310b71f5f57fc4fc07c997bff5de654dbf9b86d4a5cd584619d05310bc7`,
independently recomputed from the actual tarball. The
[consumer record](w18-runs/finish-20261013-package-consumer.json) and
[raw Playwright report](w18-runs/finish-20261013-installed-playwright.json) retain
that binding and the observed results. The following evidence-only commit changes
root documentation and retained reports; it changes no packaged source, types,
assets or documentation from the tested implementation revision.

Not run: the existing optional W16 ten-minute soak, the Windows-inapplicable
Unix UID test, physical W00 profiles or cross-browser qualification. Browser
evidence is local flagged Chromium preflight only. A separate agent inspected the
merge, diagnostic contract and validation diff without finding an actionable
defect. No push or pull request was made.

Use the [review prompt](w18-review-prompt.md) to assess the final branch independently.
