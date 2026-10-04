# W12 verification

## Review corrections after 55cfe2c

Dual-source vector resolve retains the native medium accumulation controls
(`alpha^1.1` and `0.875` destination decay), but returns scene colour without
Reinhard or gamma conversion. W11 owns tone mapping and output encoding.
Opaque red, grey 0.2 and white must match standard, WBOIT, dual-source and auto,
both alone and beside a disjoint translucent feature. The colour probe also
checks HDR input, Reinhard output and the final sRGB pixel against independent
equations for opaque and translucent input.

Opaque/translucent pass classification also uses a flat source-alpha flag.
Perspective interpolation of alpha 1 can round below 1, otherwise routing an
opaque surface into the translucent pass without depth writes. Ordinary/far
overlapping surfaces retain nearest colour and pick ID in all four OIT modes
and both draw orders.

Successful camera changes invalidate both pick and highlight targets. Selection
and hover tests compare actual feature coverage with the moved tint and outline;
immediate point, rectangle and lasso queries must equal queries after rendering.
The camera cases include view translation and projection changes. Resize creates
fresh dirty targets, and capture already invalidates its temporary projection.

The review's previously unverified depth concern also reproduced: with a flat
zero-offset drape and camera height 0.0101, independent clip z/w rounding put the
polygon behind terrain (zero red or picked pixels in CPU and GPU modes), while
height 0.01 covered 1,764 pixels. Positive biased depth now rounds clip z down and
w up on the existing absolute `2^-19` storage grid. This cannot reverse the bias;
its NDC error shrinks with distance, preserving ordinary/far depth precision.
Unbiased and outside-depth vertices retain their previous storage. Near-drape tests check
both heights and projection paths; ordinary/far tests reject hidden terrain
geometry and verify close opaque ordering in both draw orders. A varied-height
projection case includes an arithmetic-sensitive vertex and exact CPU/GPU IDs.
The core regression also bounds near-camera screen displacement below 1/16 pixel.

The distant-depth probes also reject a coarser `2^-19` NDC floor. Its negative
control is retained in `C:\devin-target\w12-r123-depth-coarse.log`; a surface
behind terrain became visible and nearby opaque layers changed ordering.

The new tests failed against the original 55cfe2c WASM. Baseline logs are retained
at `C:\devin-target\w12-r123-color-baseline.log`,
`C:\devin-target\w12-r123-camera-baseline.log` and
`C:\devin-target\w12-r123-depth-baseline.log`. These failures include the wrong
HDR input, missing moved highlights, stale picks, and invisible near drapes.

These regressions are covered in `w12_vector.spec.ts` and `w12_camera.spec.ts`,
and mirrored by the installed consumer through built `dist` modules. The M6
benchmark now dirties the highlight targets on each measured selected frame,
retaining the original two-times bound. Its old cached-frame measurement below
describes the earlier evidence only.

The final evidence for these corrections is retained separately at
`C:\devin-target\w12-evidence\r123-final-evidence.json`, with the exact tested
commit and tarball digest. The prior records below describe 55cfe2c and its
pre-amend candidate; they are historical evidence, not the correction's package.

Correction source gates passed on local Windows Chromium: W12 has 14 unit and
32 browser tests; W11 has 21 unit and 7 browser tests; the complete unit suite
has 768 tests in 51 files. API/type checks, parity verification, the 22 pinned
fixtures, and the infrastructure spec inventory pass. Rust core has 380 passing
tests and web has 189. The installed-tarball gate runs last on the clean commit
and mirrors the colour, camera, near-drape and 41 depth-occlusion/arithmetic cases.
Other browser and hardware profiles remain outside this evidence.

## Earlier W12 evidence

The corrected T12, P12 and V01–V04 implementation is checked against native
`1f4084af428dc699bdcd108b029736cb73903926`. The original 18 pinned files retain
their `bf8db93233e5158f6d226991fc5d230832c2d806` bytes and checksums and are
also verified byte-for-byte at `1f4084a`. Four additional fixtures pin native
dual-source controls, pipeline, defaults and compose, for 22 sources total.
The Luxembourg conversion remains 2,035 rail paths / 23,277 positions.

The implementation writes opaque vectors into depth first, draws translucent
vectors against that depth, and then draws picks. Auto chooses available
dual-source or reports the WBOIT fallback. The dual-source test independently
evaluates native medium accumulation controls, within one RGBA8 code value, in
both orders. WBOIT order probes now use different depths. Miter, bevel, segment
quad and cap assertions compare covered pixels.

GPU projection uses a hierarchical stable prefix sum and exposes actual output
bytes for comparison with `project_and_cull`, including sparse visibility across
200,000 triangles. Highlights use sorted lookup and one bounded neighbourhood
scan, then reuse cached effect targets until their inputs change. Geometry and
pipelines survive selection/hover/time changes, including scene commits.
Point picks stage one pixel and area picks stage their clamped bounding box;
clean pick targets are reused. Capture uses reserved vector ID `0xffffffef`,
camera-facing normals, and per-sample projection jitter while retaining the
unjittered reference ID pass. See [vector layers](vector-layers.md) for the public
contracts, limits, AOV namespace and scene absent/null semantics.

All eight inherited browser cases remain. The 15 added cases below have their
probes in `examples/test-w12-vector.html` and equivalent assertions in
`scripts/test-w12-package.mjs`. Existing pixel, coverage, ID, precision, memory
and timing thresholds were preserved. The former dual-source-equals-standard
comparison was replaced, as requested, by the independent native equation.
The original 18-source count and every checksum remain locked while the four
new sources are additionally required.

| Finding | Browser test name |
| --- | --- |
| H1 | `H1 opaque nearest surface owns color and pick ID in auto/standard and both orders` |
| H2 | `H2 24px miter contains bevel, bevel contains segment quads, limit falls back and cap pixels differ` |
| H3 | `H3 dual-source matches the independent native medium accumulation equation within one code value in both orders` |
| M1 | `M1 auto chooses available dual-source and reports unavailable-feature fallback` |
| M2 | `M2 vector feature 1 uses reserved ID AOV distinct from terrain and retains full pick ID` |
| M3 | `M3 draped flat polygon normal faces camera and matches terrain within 1e-3` |
| M4 | `M4 sixteen offline samples have fractional vector edge coverage and unchanged reference ID AOV` |
| L1 | `L1 absent scene vectors retain runtime layers and explicit null removes them` |
| L2 | `L2 vector geometry limits throw the public Forge3DError with RESOURCE_LIMIT_EXCEEDED` |
| L4 | `L4 graph styles retain drape and only an explicitly set input overrides both` |
| M5 | `M5 stable parallel compaction is byte-identical to project_and_cull and 200k GPU triangles are no slower` |
| M6 | `M6 2000 selected IDs with 32px outline/glow cost at most twice the unselected frame and exceed old cap` |
| M7 | `M7 point picking uses at most three padded rows at 1920x1080 and clean picks do not render` |
| M8 | `M8 selection hover and time commits create no pipelines or vertex buffers` |
| M8 | `M8 Luxembourg selection commits in less than 50ms without geometry or pipeline creation` |
| L3 | The M6 test also commits 5,000 selected feature IDs, proving the arbitrary 4,096 cap was removed. |

The new probes were copied into a detached `dda099f` checkout and run against
its own built WASM. They fail there and pass on the corrected implementation.
Local baseline failure logs are retained outside Playwright's output directory:

- `C:\devin-target\w12-baseline-regressions.log`: H1/H2/H3/M1/M4/L1/L2/L4 failures;
  H2 loses 66 bevel pixels, dual-source differs from native by 94 code values,
  and the 16-sample capture has zero fractional edge pixels.
- `C:\devin-target\w12-baseline-corrected.log`: explicit terrain upload fixes the
  probe setup; M2 receives vector ID 1, M3's normal error is 2, M6 costs
  2,455.6 ms versus 9.2 ms unselected, and M7 peaks at 49,766,400 staging bytes
  against its 768-byte limit.
- `C:\devin-target\w12-baseline-performance.log`: M5 lacks the GPU projection
  diagnostic and the Luxembourg selection commit takes 917.5 ms against 50 ms.
- `C:\devin-target\w12-baseline-m8.log`: the updated M8 counter probe also
  rejects the baseline's unavailable creation counters.

Frame benchmarks warm three frames and compare medians of nine synchronized
render/readback frames. They assert 200k-triangle GPU time <= CPU time and
2,000 selected IDs with outline/glow 32 <= 2x unselected time, without loosening
either bound. These measurements qualify the tested local adapter.

Required source gates:

| Command (from `crates/forge3d-web`) | Result |
| --- | --- |
| `npm run test:w12` | 14 unit tests in 2 files; 23 Chromium browser tests |
| `npm run test:unit` | 768 tests in 51 files |
| `npm run test:api` | Both TypeScript projects, public snapshot and emitted facade pass |
| `npm run verify:parity` | 15 verifier tests; 84 capabilities / 6,531 mappings; zero untracked, duplicate, unresolved, schema or lock errors |
| `python scripts/generate-w12-native-fixtures.py --check` | 22 sources; 2,035 paths / 23,277 positions |
| `cargo test -p forge3d-core --features webgpu` | 379 tests; 0 failed |
| `cargo test -p forge3d-web` | 189 tests; 0 failed |

The camera regression spec is registered in the infrastructure spec list.

The installed-tarball gate requires a clean commit. It builds and installs the
package in a separate consumer, executes every mirrored W12 probe through
`dist`, verifies module worker/offscreen behavior, exercises both adapter cases,
and renders both examples. It rejects source TypeScript requests and page errors.
The clean installed consumer passed all mirrored cases, including the module
worker, offscreen renderer and both examples, on Chromium 148.0.7778.96.
T12, P12 and V01–V04 therefore retain I.

The documentation evidence revision is
`7b18ec1fabe32ae0f405601cf0df9bf8844d27c9`; its installed tarball SHA-256 is
`df1e29580f7fb8bf27e59fac1c7d4e2ca273b0df85bfa8c5b86cb346b0d6f8c1`.
Its immutable copied record is
`C:\devin-target\w12-evidence\candidate-evidence.json`. That candidate and
the final commit have identical runtime, tests, scripts, fixtures and declarations;
only documentation changes in the final amend.
The package gate is rerun last on the final clean commit, with its authoritative
revision and tarball SHA-256 copied to
`C:\devin-target\w12-evidence\final-evidence.json`. Keeping that final record
outside Git avoids embedding a commit's own hash inside itself.

| Installed probe | Measured result in the documentation evidence |
| --- | --- |
| H1 | Center [255,0,0,255], pick 1, zero color/ID mismatches in all four cases |
| H2 | Zero missing bevel/quad pixels, 78 extra miter pixels; exact bevel fallback |
| H3 | Native CPU RGB matches exactly in both orders (delta 0) |
| M1 | Available dual-source and forced-unavailable WBOIT/fallback both pass |
| M2/M3 | Vector AOV 4294967279 versus terrain 1; pick 1; both normals [0,1,0] |
| M4 | 94 fractional edge pixels at 16 samples versus 0 at one; ID delta 0 |
| M5 | GPU/CPU bytes identical, including the large sparse compaction; 4.0 ms GPU <= 56.9 ms CPU |
| M6/L3 | 5.1 ms selected <= 2 x 4.1 ms plain; 5,000 selected features accepted |
| M7 | Actual ledger staging peak 768 bytes; clean picks add zero renders; bounded area picks pass |
| M8 | No pipeline or vertex-buffer creations on selection/hover/time or scene highlight commits; Luxembourg commit 0.4 ms |
| L1/L2/L4 | Absent keeps/null removes; public resource error; graph drape inheritance and explicit override pass |

These are observed values; the assertions continue to enforce their original
bounds rather than pinning this particular machine's timings.

Reproduce in this order, with the package consumer last. Copy its evidence before
running any further command because another Playwright invocation wipes
`test-results/`.

```powershell
$env:CARGO_TARGET_DIR = 'C:\devin-target\forge3d-web'
npm run build:wasm
npm run test:w12
npm run test:unit
npm run test:api
npm run verify:parity
python scripts/generate-w12-native-fixtures.py --check
cargo test -p forge3d-core --features webgpu
cargo test -p forge3d-web
# Commit the reviewed changes, then confirm git status --porcelain is empty.
New-Item -ItemType Directory -Force C:\devin-target\w12-evidence | Out-Null
npm run test:package-consumer:w12
if ($LASTEXITCODE -ne 0) { throw 'W12 installed-package gate failed' }
Copy-Item -LiteralPath test-results\w12-package\evidence.json `
  -Destination C:\devin-target\w12-evidence\final-evidence.json
```

The current evidence covers local Chromium on Windows. Other browser and
release hardware profiles were not rerun for these corrections.
