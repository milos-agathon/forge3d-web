# W18 review corrections

The review's six defects are repaired on `codex/w18-mapscene`. M01/M02a remain
implemented; M02b conforms by retaining diagnostics. Its precondition was not
changed: G02-G04/W16 acceptance and independent laz-perf sign-off remain open.
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
| Clean installed W18 consumer | Pending final clean-checkout run |

The [native audit](w18-runs/review-native-audit.json) records each exact file hash.
The old [verification record](w18-verification.md) and original raw runs remain
historical evidence; their point/tiles promotion and broad coverage claim are
superseded. Browser observations are local flagged Chromium preflight evidence,
not physical W00 or cross-browser qualification. No subagents were used.

Use the [review prompt](w18-review-prompt.md) to assess the final branch independently.
