# W23 remaining review corrections

All six findings against `5b3d1025` are fixed. Acceptance remains **W23 as written at `d5cf3b57`** in the [plan](../superpowers/plans/2026-06-04-forge3d-browser-webgpu-wasm-runtime.md#w23--restore-documentation-examples-goldens-and-migration-guides). No acceptance criterion, existing assertion, timeout, or threshold was weakened.

Initial implementation: `391c84362ecfc8f54588f45dd38aad8e2f0fc184`. The first complete verification ran sequentially on that clean revision, with `CARGO_TARGET_DIR=C:\devin-target\forge3d-web`; subsequent clean verification revisions are recorded below. Changes are confined to `D:/forge3d-web/.worktrees/w23`, branch `codex/w23-documentation`; no other worktree or branch was edited. The user subsequently authorized pushing this branch and opening [PR #57](https://github.com/milos-agathon/forge3d-web/pull/57). This ledger and the [verification record](w23-verification.json) are committed separately from implementation changes.

| Finding | Status | Reproduction and verification evidence |
| --- | --- | --- |
| 1. Triangle, COG and MP4 were self-reported | Fixed | The observer outside `workflows.js` pairs the actual MapScene mesh `triangle` recipe with its removal control: **629 changed RGB pixels**, exceeding 8. Decoding the downloaded PNG produces the same dimensions and SHA-256 as that rendered frame. COG observation records open/readTile at actual overview levels **0, 1, 2**, **8 accepted runtime uploads**, convergence and covered readback inside the COG stage. VideoEncoder configure/encode/output/flush calls are observed per step; **10 MP4 downloads per lane**, each parsed for ftyp, an avc1 sample entry, and stsz matching the actual frame count: 3 each, 8 for Khumbu. Results agree in source, dist and installed lanes. A served literal-only replacement with its matching manifest hash passes startup integrity but each triangle/COG/video stage independently fails `assertStageEvidence`, with zero observed stage events: **3 rejections per lane, 9 total**. Existing no-op controls and all six observation-erasure controls also pass. |
| 2. Generator provenance named unrelated scripts | Fixed | `validateAssets` requires an output declaration in the named generator, or the adjacent manifest's matching generator plus an explicitly listed file. **2,037 generated-control assets** pass output proof. W10/native uses `generate-w10-render-goldens.py` and native-derived origin; the five W18 resources are explicitly authored contract inputs. Substituting the existing `generate-w18-native.py`, with its correct current digest, for the glacier generator fails with `Generator does not declare asset output`. Manifest tests also reject a wrong generator and an unlisted filename. |
| 3. Incorrect routing | Fixed | Own subjects precede supporting clauses, containing bullets and release titles. The audit asserts every requested changelog subject and both Rotterdam definitions. All **175 corrections against efba9305** were re-reviewed using excerpts from **29 pinned native files**; there are **31 changes from 5b3d1025**. The audit has **27 exact changelog expectations and 2 Rotterdam expectations**. The [routing review](w23-routing-review.json) records source lines, hashes, previous routes and new routes. |
| 4. PNOA used Rainier instead of its original DEM | Fixed | Native `1f4084a:examples/pnoa_river_showcase.py:25` names `assets/tif/Bryce_Canyon.tif`. The capture script now agrees. Recaptured from `D:/forge3d`: window `[2000,1900,16,16]`, EPSG:26912; original-file SHA-256 `9052ee54f4ef23b56c6981bc2a7672117c6f5ecb430726530f4fe456e6484a39`, converted float32 SHA-256 `c1cc00ac8e4c4bc697d2ebd93a93c229f7987e5958f77018fbe8d15577fe6be7`. Application fixtures, migrated inputs, source snapshots and manifests were regenerated. The new source assertion, Python check and all three browser lanes pass. The separate PNOA video input retains its own source. |
| 5. CRLF checkout drift | Fixed | `workflows.js`, `application-analysis.js` and `regional-kernels.js` have LF checkout bytes. The installed consumer checks raw bytes of **all 18 shipped migration text files** against their HEAD blobs, for both checkout and installed files, in addition to existing normalized digest checks. All pass; **207 shipped assets** are digest-verified. |
| 6. Font-shaping unit timeout | Fixed | The async fontkit mock's `importOriginal` and lazy pdf-lib load formerly ran inside the timed test. Both real backends now load during test collection; the shaping-error and cancellation assertions remain unchanged. A focused run measured **6.99 s collection / 23 ms assertion**. Three consecutive default full runs each passed **1,960 tests / 92 files**; shaping assertions took **19, 21, 24 ms**. The **5 s timeout remains unchanged**. |

The observer also uncovered swapped COG arguments: `readTile` takes `(x, y, lod)`. The workflow now reads `(0, 0, overview)` and `(x, y, 0)`, and observation records `selectOverview(lod)` rather than mislabeling x as the overview.

## Further corrections found during review

Beyond the requested routing subjects, source context required:

- Terrain-pipeline reuse → T02; both GL/WGPU camera matrix helpers → C01.
- Atmospheric Depth feature/release/subsection headings and jittered fog marching → P09; texture-size accounting → R07.
- Python PBR math → P04; texture setters and TBN generation → P05; point/spot-light shader fix → P01.
- MapScene introduction → M02a; B3DM, tileset parser and hierarchical traversal → G04; CopcDataset asset management → G02.
- Both preset acceptance commands → R04; numpy_to_png RGB-array support → E07.

Tightened provenance also corrected W10 shader JSON to its native-fixture generator, browser frames to browser observations and W09 preservation to its real capture script; W15 mesh/audit outputs to their actual writers; unsupported W10 harness/volume, W11/W12 provenance, W14 contract, W16 upstream metadata and adapted W20 claims to authored inputs; and the W22 Basis input to upstream dependency provenance. These are explicit provenance corrections, not removals from coverage.

## Commands and results

Preparation included `python scripts/capture-w23-dem-inputs.py` (7 original DEM windows), `python scripts/generate-w23-application-fixtures.py` (24 examples / 29 operations), `node scripts/generate-w23.mjs`, `node scripts/audit-w23-semantics.mjs --capture`, and `node scripts/capture-w23-routing-lock.mjs --capture`. The routing lock was recaptured byte-identical: it locks row APIs/tests/examples, while artifact route changes live in the reviewed source-context record.

The clean gate runner was `node scripts/run-w23-review-verification.mjs` from the repository root. It ran these commands sequentially from `crates/forge3d-web`:

```text
npm run verify:w23
npm run verify:parity
npm run test:api
npm run test:unit
npm run test:unit
npm run test:unit
npm run build:example
npm run test:package
npm run test:w23 -- --reporter=list,json --output=test-results/w23-review3-browser-output
npm run test:package-consumer:w23
python scripts/generate-w23-goldens.py --check
python scripts/generate-w23-application-fixtures.py --check
```

Then, from the repository root:

```text
python scripts/audit-w23-native.py
node scripts/audit-w23-semantics.mjs
```

All **14 commands exited 0** on the recorded implementation. Browser commands use the `chromium-preflight` project; only the source/dist command receives `FORGE3D_TEST_PORT=57923`. Installed JSON reporting has a separate output path. Exact working directories, start/end times and SHA-256 of every command log are in `validation.commands` in [w23-verification.json](w23-verification.json).

W23 checks: **66/66**; source/dist browser cases **2/2**; installed browser case **1/1**. Package Node suites: **97/97**, **118/118**, and infrastructure **628 passed / 1 existing platform skip / 0 failed** (the real Unix-UID ACL case on Windows). Documentation: **33 compiled fences**, including **2 strict complete examples**, 38 shipped documents and 1,216 checked links. Coverage remains **91 rows / 6,531 artifacts / zero unmapped**. The independent native audit retains **54 examples, 88 documentation assets, 53 Markdown/RST pages, 191 named test files and 1,792 test definitions**.

| Recorded input/output | SHA-256 |
| --- | --- |
| Coverage manifest | `7ad44138bf42401c4a03b358605b9ab03f741cd16de323cce8751d44466b355d` |
| Asset manifest (2,582 assets) | `3d4f689f0e29646c981b013d9b0c39706ae6e2cf820a3087f7d286269a4575e1` |
| Installed tarball | `c62ac9aac94e1bef511008d501dbee61692302da2732b98cdaa23e4fb9683418` |
| Installed WASM | `50dc3d9a9be830f71d05739820ee5a0e2d5c826c70481a3492edf9d3ac738068` |

The JSON record additionally retains per-lane frame/download hashes, COG calls, encoder calls, parsed MP4 counts, negative-control outcomes and attachment digests. Earlier exploratory attempts included a Vite reload and a disk-full startup failure; neither supplied an acceptance verdict. An earlier runner attempt failed the existing default-port unit assertion because the runner leaked its browser override; that was corrected without changing the test. A later report-path collision was corrected and the complete clean sequence repeated, preserving both source/dist and installed evidence.

## Declared limits retained

These bounded offline workflow migrations do not reproduce the full geographic publications or establish native GPU visual parity. Historical test routes identify capability evidence, without claiming execution of every original Python assertion. W09 historical captures retain kernel hashes and parameters; their original authoring harness remains unarchived. The browser lane is Chromium preflight, not physical-browser qualification. Physical browser/GPU evidence and final functional/visual release closure remain W24 work. Prior regional-kernel, IBL/effects/rig, license, shadow, guide, disposal and integrity checks remain in force.

## CI follow-up and repeated clean verification

CI run [39446226438](https://github.com/milos-agathon/forge3d-web/actions/runs/39446226438) passed both the early and original late raw-byte Python oracle checks, then exposed an adapter-dependent OIT negative control: replacing `setOit` with a no-op leaves `auto`, which selects WBOIT when dual-source blending is unavailable. The control now forces standard blending, removing the actual WBOIT contribution while preserving the existing `/Weighted OIT/` failure assertion. Source, dist and installed cases all reject this control; each also rejects all three matching-hash literal stages. No timeout or threshold changed.

The earlier early-oracle attempt also exposed a missing scratch directory on a fresh checkout. `build_cases` now creates `test-results` before using `TemporaryDirectory`; an isolated fresh-root probe produced all 24 examples / 29 operations exactly. Oracle diagnostics save candidate bytes and first differing JSON paths without weakening raw equality. The first CI numeric mismatch remains unreproduced locally; subsequent CI checks passed at both validation points. The original late validation point and all three workflow jobs remain in place.

All 14 commands above were repeated sequentially on clean committed implementation `c79ce62fb068bc3fd59c0d5316be431de4a3d72c`, using isolated `w23-review4-*` logs. All exited zero. Three consecutive unit runs again passed 1,960 tests / 92 files; the shaping assertion took 22, 27 and 28 ms with its five-second timeout unchanged. Source/dist were 2/2 and the installed case 1/1, including all no-contribution controls and nine literal-stage rejections. The installed consumer again verified all 18 migration text files against raw HEAD blobs and all 207 shipped asset digests. Exact commands, timings, log/attachment digests, current manifest digests and installed package/WASM digests are in `ciFollowup` in [w23-verification.json](w23-verification.json). The earlier record remains historical evidence for `391c8436`; declared limits above still apply.

## Native-bundle CI compilation follow-up

The macOS Chromium [native-migration probe](https://github.com/milos-agathon/forge3d-web/actions/runs/39456234433/attempts/3) acquired a SwiftShader adapter after two hosted-runner capacity cancellations. Its native archive's first rendered frame arrived at 15,087 ms and the restored archive reached rendering at 15,481 ms; the unchanged 30-second test deadline expired during the second render.

An independent GPU-call regression exposed eager compilation of denoising, luminance and world surface-AOV pipelines during a plain depth capture. These now compile on first use and remain cached for the runtime or world specialization. The regression fails before the change with counts `{denoise:1,luminance:1,surface:1}`; source and dist now observe `{0,0,0}` for plain capture and `{1,1,1}` after both first and repeated requests. Both native archive renders retain identical offline pixels, 13,288 covered pixels and zero network reads in the local diagnostic. Local hardware timings are diagnostic; the unchanged macOS SwiftShader probe is the acceptance check.

Focused verification passed all 192 Rust web-crate tests, all ten unchanged W19 native probes, three W06 readback/convergence/CPU-reference denoiser oracles, and both compilation regressions. All 14 requested commands were then repeated sequentially on clean implementation `c37b72e1398b58e5df9a5cd1943474fd3f5dea8f`, with three consecutive full 1,960-test unit runs, source/dist 2/2 and installed 1/1. Exact commands, counts, before/after GPU-call observations, digests and original CI reproduction are recorded in `captureCompilationFollowup` in [w23-verification.json](w23-verification.json). The previous local sequence stopped at the installed clean-tree guard when rebuilding refreshed the codec implementation fingerprints; those generated fingerprints are committed before this complete repeat. No existing assertion, timeout, runner or required context was weakened; declared limits remain in force, including WebKit's existing missing-WebGPU `NOT_PROVEN` classification.

## MapScene CI readback follow-up

CI run [39477436677](https://github.com/milos-agathon/forge3d-web/actions/runs/39477436677) passed the Windows build/contract checks, installed W23 workflows and both raw oracle validation points. The original 30-second W19 native probes also passed on macOS SwiftShader. Full Chromium passed 419 tests with 10 existing skips; only the W23 source/dist cases exceeded their unchanged ten-minute deadlines during `run('all')`.

The new independent GPU-call regression failed on three unnecessary offline kernel compilations while exact RGBA and coverage already matched. For ordinary opaque MapScene output, coverage now reads the preserved depth attachment from the canonical RGBA draw, avoiding the redundant HDR capture. Source and dist produce byte-identical pixels and equal coverage for terrain and mesh scenes, compile none of those offline kernels, and release all GPU memory. Offscreen geometry still raises `empty-render-output`. Complex scenes retain their previous capture path. Temporary storage and readback allocations are admitted together in the existing ledger and released on completion or error.

Focused verification passed all 32 MapScene cases, 16 related capture/native-archive cases and 192 Rust web-crate tests. All 14 required commands then passed sequentially on clean implementation `bdff104b48eb4e2a65215c67e8d22cda88d2d546`, including three consecutive full 1,960-test / 92-file unit runs, source/dist 2/2 and installed 1/1. Each lane rejects the three matching-hash literal stages and all existing contribution controls. The installed consumer checks all 18 migration text files against raw HEAD blobs and all 207 shipped asset digests. Exact commands, counts, digests and differential readbacks are in `mapReadbackFollowup` in [w23-verification.json](w23-verification.json). Independent stage timings and an additional early W23 source probe improve CI feedback; the full corpus, deadlines, runners, required contexts and declared limits remain in force.

## Exact regional oracle backend follow-up

CI [39505427250](https://github.com/milos-agathon/forge3d-web/actions/runs/39505427250) saved the candidate that made the host-dependent float32 mismatch reproducible. All 78 differing shades match a sequential fused multiply-add calculation exactly: 6 Romanian, 47 German and 25 Bosnian pixels. The local non-fused `normal @ light` matches every committed value. The unchanged native `_hillshade` helper ends in a BLAS matrix/vector product; host kernel selection explains the two bit patterns.

The generator now selects the fixed Haswell OpenBLAS kernel and one thread before loading NumPy, using [OpenBLAS's documented runtime selection](https://www.openmathlib.org/OpenBLAS/docs/runtime_variables/). A normal/light pair from the failing input checks exact float32 bits `1062074350` across 16 rows before generating anything. A conflicting inherited SkylakeX/four-thread setting is replaced; the loaded cores report Haswell and the full raw-byte check passes. The same check passes under Python 3.13.16. The original native helper bodies, numerical fixture bytes, operation tolerances and raw-byte equality assertions remain unchanged; provenance now records the numerical environment.

The affected CI runner passed both early raw-byte oracle checks on backend implementation `a811d6e9` in [39506661835](https://github.com/milos-agathon/forge3d-web/actions/runs/39506661835). All 14 requested commands then passed sequentially on clean implementation `500f927931c2db85fc845b29145422d50a67f4df`, which adds the directly runnable [numerical audit](../../crates/forge3d-web/scripts/audit-w23-numerics.py) and precise commentary. The audit traces intermediates from the unchanged native helper and reproduces the entire saved CI document, including equality of every other field. Differences reach 61 ULP near cancellation, with maximum absolute difference below 6e-8; no tolerance was changed. The complete gate sequence includes three consecutive 1,960-test / 92-file unit runs and all three source/dist/installed W23 cases with their negative controls. The installed consumer again checks 18 raw HEAD text blobs and 207 shipped asset digests. Exact commands, counts, before/after output digests, the complete numeric reproduction and CI step evidence are in `numericBackendFollowup` in [w23-verification.json](w23-verification.json). Stage timing logs are now bounded to stage labels. The full suites, deadlines, required contexts and declared limits remain in force; the early CI step is not a claim that the entire run passed.

## Remaining macOS render cost

The Windows installed consumer in [39506661835](https://github.com/milos-agathon/forge3d-web/actions/runs/39506661835) passed in 463,476 ms, rejected all 10 contribution controls and three literal-stage replacements, and verified 18 raw HEAD migration text files plus 207 assets. The macOS native probes passed their original 30-second deadlines. The focused macOS W23 source probe still reached its unchanged 600-second deadline during example 31, Luxembourg; independent timings show repeated environment/animation/video stages taking 28-30 seconds.

Complex MapScene coverage now reads the same unjittered W06 G-buffer reference without a discarded jittered beauty sample, accumulation, tonemapping or unrelated AOV readbacks. The canonical RGBA draw remains. Eight source/dist differential cases prove identical pixels and equal coverage for layered geometry, TAA, water, and combined sky/fog/cloud/density-volume scenes, with no offline kernels and zero retained GPU bytes. The previous implementation fails the compilation assertion. W08, explicit canvases and point composition retain the full capture lifecycle. The new temporary targets, camera uniform and padded readback buffer are admitted together and released on all results.

Each of the ten video workflows immediately follows animation. Video now encodes that completed sequence of real rendered CPU frames, preserving all PNG outputs, timestamps, encoder calls and MP4 validation. Any intervening workflow or retained-view render invalidates the sequence; it is consumed once. The new Node regression fails before the change with six renders instead of three; all three reuse/freshness/cancellation cases now pass. No workflow entry or existing assertion was removed.

Focused verification passed 38 MapScene cases plus two additional fog/cloud/volume comparisons, 16 related capture/archive cases and 192 Rust tests. All 14 required commands then passed sequentially on clean implementation `f8973adae365c83e8979c12c22ff3c5fbf4b967b`, including three full 1,960-test / 92-file unit runs and all three source/dist/installed W23 cases with their negative controls. Exact commands, counts, digests and differential observations are in `referenceDepthAndFrameReuseFollowup` in [w23-verification.json](w23-verification.json). The 600-second W23, 30-second native and five-second shaping deadlines, all required contexts and declared limits remain unchanged. CI must still establish completion on the latest PR head.
