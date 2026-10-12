# W18 implementation verification

W18 implements M01, M02a and the M02b diagnostic contract in the worktree
`C:\Users\milos\.codex\worktrees\w18-mapscene\forge3d-web`, branch
`codex/w18-mapscene`. Implementation commits are `5816826` and `1ed6e66`.

The [public contracts](../../crates/forge3d-web/docs/mapscene-diagnostics.md) cover
owned typed recipes, validation, completed layer adapters, real raster/point/trace
PNG output, cancellation, disposal and deterministic review JSON. The
[native audit](../../crates/forge3d-web/docs/w18-evidence.md) and
[94-definition coverage ledger](../../crates/forge3d-web/docs/w18-native-test-coverage.json)
record independent source/fixture verification and the seven W19-owned cases.

Verified on 2026-10-12:

| Gate | Observed result |
|---|---|
| Fresh `build:wasm` | Passed with `CARGO_TARGET_DIR=C:\devin-target\forge3d-web` |
| TypeScript build, dist preparation and public API/type snapshot | Passed |
| Complete unit suite at `1ed6e66` | 70 files, 1,224 tests passed |
| W18 source/dist browser suite | 28 passed, zero skips/failures/flaky cases |
| Installed-tarball strict consumer and W18 browser suite at `1ed6e66` | 14 passed, zero skips/failures/flaky cases |
| Focused shared W16 point renderer regression browser cases | 2 passed |
| Aggregate `test:package` | Passed: 15 documentation, 118 browser-harness and 627 infrastructure tests; one Unix-UID infrastructure case skipped on Windows |
| `verify:parity` | 15 tests passed; 6,531 inventory mappings, zero untracked/duplicate/unresolved entries |

The [source/dist raw report](w18-runs/source-dist.json) was captured from the
implementation worktree before its first commit. The subsequent terrain summary
fix was covered by the final full unit suite and installed suite. The
[installed browser report](w18-runs/installed-playwright.json) and
[package-consumer record](w18-runs/package-consumer.json) bind the installed run
to revision `1ed6e663a7facd4f3d49cb01dac0dc92a5acd24e` and tarball SHA-256
`7cc00270670c61da405909a3e4b53f1cf6e7620404329e07dc0f977ba7d48c5f`.
The tarball digest was independently recomputed after the run. Its runtime and
assets were served exclusively from the separately installed package. The first
consumer run identified an incorrect `.mjs` MIME type in the test server; the
mapping was repaired before the passing run.

The [captured example](w18-runs/mapscene.png) shows the installed package's terrain,
imagery, roads, buildings, mesh/scatter, points, shaped glyphs and annotation.
Each completed example layer has a removal test that changes actual covered pixels.

Browser results are local flagged Chromium preflight observations. Physical W00
profiles and cross-browser release qualification remain separate. ZIP/style
evaluation/save/load belong to W19; cartographic furniture/export belong to W20.
Unavailable product paths retain blocking diagnostics.

The previous branch and worktree registration were removed. Recursive deletion
of the remaining files at `D:\forge3d-web\.worktrees\w17` was rejected by automatic
approval review, so that physical directory remains outside this worktree.
