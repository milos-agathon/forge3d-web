# W16 implementation and acceptance evidence

W16 acceptance is pending. G02, G03 and G04 remain `P`: the runtime and local
conformance tests exist, but local p95 variation remains unexplained. The earlier
18.3 ms failure and three current passes use identical dist/asset bytes. The pinned W00 physical
reference-profile runs and the mandatory laz-perf security review are open. The original required outcomes
and acceptance criteria in the plan and baseline are preserved.

The worktree starts at W15 commit `f0287e5b1594542635f8b088e2ae88d7be8ec435`;
B3DM calls W15's plain-glTF decoder. No previous completion claim substitutes
for executable verification.

## Independent fixtures and selection references

`tests/fixtures/w16/copc-ept-tiles-v1.json` pins every fixture and 21 native
source/test files at `bf8db93233e5158f6d226991fc5d230832c2d806`. Original
Autzen LAZ (110,000 points) and ellipsoid COPC (100,000 points, five chunks)
retain exact Float64 position/RGB hashes from laspy 2.7.0 and lazrs 0.8.2.
Original ellipsoid data remains the full-chunk decode conformance test.

The range-overview fixture is a separately generated 200,000-point COPC:
two real Autzen patches, the second translated in X. Its 512-point coarse root
includes every XYZ extremum and every occupied octant. Eight additive leaves
contain the remaining points. Independent laspy whole-file and CopcReader
decoding validate the file, including its LASzip chunk table and hierarchy EVLR.
The overview admits that root at a 5,000-point budget, checks its exact decoded
hashes and whole-dataset extent, requires visible GPU coverage, and measures
only actual Range/206 responses. A budget below the root count must produce
no selected keys and a clear frame. A detail-only patch cannot pass this probe.

W00 already pins one million points, depth eight and 64 camera keyframes in
`tests/parity/fixture-contracts.json` at the W15 base. **The spatial layout and
camera path are new W16 fixture design**, not a previously established W00
workload. `workload-ept` independently resamples Autzen into octree cells;
it is a synthetic stress layout, not an unmodified million-point survey.
Its 1,865 positive nodes total exactly one million points, with 457 branching
parents and nodes at every depth from zero through eight. Every node's decoded
coordinates and colors are checked against independently encoded Python bytes.

There are two distinct selection references:

- 64 exact native public REPLACE records, executing pinned Python code.
- 64 independent Python ADD/frustum records, executing the same native bounds,
  priority and SSE helpers with explicit additive admission and six homogeneous
  clipping planes. The native public API provides neither ADD nor frustum
  selection, so these records are policy-oracle references, not a native ADD API.

The ADD views couple camera position to a perspective matrix, pan and zoom,
produce 64 distinct unordered selections, and cull 354–1,154 fixture nodes.
Generation asserts strict budget and ancestor closure. Its negative control
reintroduces rejected-parent descent and demonstrates orphan detail selection.
Browser tests exercise these records through the actual default ADD layer;
disabling the frustum changes all 64 selections. SSE is compared at nine
decimal places to exclude insignificant NumPy/JavaScript last-bit differences.

The 3D Tiles references now include `tile-traversal-v2.json`: four branching
85-node tilesets (ADD, REPLACE, mixed and inherited refinement), 64 cameras
each and 256 exact native selection/SSE records. They cover box and sphere
bounds, contentless parents, varying viewport/FOV/SSE and ADD depth limits,
producing 40 distinct selections. A native ADD-to-REPLACE negative control
must change the selected set. Unit, source/dist browser and installed-package
tests execute the same records. The original two-camera real-payload probe
also remains.

`scripts/w16_fixture_tiles.py` executes the pinned native `Tiles3dRenderer`
directly. Inherited refinement uses native Tile objects with empty refinement
strings: its JSON parser otherwise inserts REPLACE for omitted refinement.
The native REPLACE depth cap drops refined children beyond the cap, while
web retains the coarse parent; REPLACE records therefore use the full depth.
Native code ignores world transforms and uses longitude/latitude directly
for region centers. Transform, region, external URL, cancellation and cache
extensions retain unit coverage and are not claimed as native parity here.

## Sustained traversal and memory

The soak traverses the same ADD/frustum keyframes with interpolated camera
poses, checks exact oracle selections at keyframes and retains the coarse root.
It awaits GPU completion and canvas presentation every frame. Reports include
visited keyframes, distinct unordered selections, minimum/maximum drawn points,
covered pixels, adapter, browser, tracked CPU bytes and peak GPU allocation.
Tracked CPU bytes cover layer buffers and compressed/decoded caches; they are
not a measurement of the browser's complete process heap.

Both Playwright and the installed-package harness enforce profile CPU/GPU
budgets and p95: discrete 1.5 GiB/3 GiB/16.7 ms, integrated
1 GiB/2 GiB/33.3 ms. The renderer also enforces its stricter local 256 MiB cap.
`FORGE3D_W16_PROFILE` chooses the target limits; choosing a name does not
qualify the physical hardware. The local Windows/NVIDIA Chromium host cannot
attest the pinned Ubuntu/Vulkan RTX 3070 or Windows Iris Xe machines.

Run `npm run test:w16` for routine source/dist conformance. Run
`FORGE3D_W16_SOAK=1 npm run test:package-consumer:w16` for a ten-minute static,
installed-tarball traversal. Reports go to `test-results/w16-package-consumer.json`
and `test-results/w16-soak.json`; retained evidence is in
[w16-local-evidence.json](w16-local-evidence.json).

### Historical local run, 2026-10-07 — performance claim withdrawn

Chromium 148.0.7778.96 on Windows/NVIDIA Ampere reported a pass in one static
installed-tarball run. This historical measurement did not reproduce in review
and is not current local performance or acceptance evidence. Its observed tarball is
`a6a6e54c20c1c02c38e517858ed998e3a4a7b46c3e65ad61a8f62cc2ef49c994`.
At recording, all 269 dist/asset files matched that tarball byte-for-byte.
That binding describes the historical runtime; the optimization below changes it.

| Check | Revised measured result |
| --- | --- |
| Unit suite | 1,077 passed across 64 files |
| Source/dist browsers | Eight W16 cases and 26 neighboring W14/W15 cases passed |
| Installed decoding and selections | Original real data hashes, all 1,865 workload-node hashes, 64 native REPLACE and 64 independent ADD/frustum records passed |
| Root-inclusive ranged overview | 33,160 / 1,263,516 bytes (2.6242%); 2,739 points including the 512-point root; 1,913 covered pixels; rejected-root negative control selects/draws zero |
| Sustained 1080p traversal | 600,049.4 ms; 33,268 frames; 14.2 ms p95; all 64 keyframes; 693 selection sets |
| Tracked peak allocations | CPU 42,918,791 bytes; GPU 42,771,504 bytes; GPU zero after disposal |
| Package/parity gates | API/type snapshots, 15 parity checks, 11 docs, 118 browser-harness checks, 609 infrastructure checks and package contract passed; one Unix-UID check skipped on Windows |
| Git provenance | All 1,902 pinned fixture/native streams match staged Git bytes |

The original report is retained in [w16-oct07-evidence.json](w16-oct07-evidence.json).
Its 14.2 ms p95 cannot support acceptance: three later review runs failed. The
full required timed path includes `layer.update`, fetch/decode misses, buffer
installation and awaited GPU completion. Camera cadence uses requestAnimationFrame
between samples; idle presentation waits are outside the measured frame work.

### Review failures reported 2026-10-09

| Harness | Host condition | p95 | Discrete target | Verdict |
| --- | --- | --- | --- | --- |
| Source/dist soak | Unit tests running concurrently | 18.7 ms | 16.7 ms | Failed; unsuitable acceptance conditions |
| Source/dist soak | Idle | 19.8 ms | 16.7 ms | Failed |
| Official installed-tarball soak | Idle | 22.3 ms; 26,768 frames | 16.7 ms | Failed |

These results are reviewer-reported, not independently rerun measurements. The
installed run passed all preceding conformance checks and exact selections, with
42.9 MB tracked CPU and 42.8 MB GPU allocations within budget. No failing run is
discarded or replaced by the historical 14.2 ms observation. New measurements
are recorded separately in [w16-local-evidence.json](w16-local-evidence.json).

### Failure reproduced and runtime optimized, 2026-10-09

A separate ten-minute source run of `4efd5e7`, with stage instrumentation and
no concurrent tests/builds, failed at **20.1 ms p95 over 28,301 frames**. Update
p95 was 10.6 ms, upload 2.1 ms and awaited GPU render 9.7 ms; these per-stage
percentiles are not additive. This reproduces the review's local failure.
Only benchmark stdout survives for that run: a subsequent Playwright invocation
cleared its temporary full JSON. The retained evidence records that limitation
and does not reconstruct unretained browser, duration or allocation fields.

The optimized runtime removes temporary arrays from homogeneous frustum tests,
memoizes EPT key/child-name derivation while preserving fresh hierarchy reads,
computes traversal priority/SSE once per queued node, copies selected records
explicitly, and packs GPU attributes from one owned data copy per node instead
of allocating objects per point. Per-frame allocation polling also avoids
repeatedly sorting the growing renderer timing history. Public timing statistics
remain enabled by default.

The point budget, camera path, cold cache misses and full timed update/upload/
GPU path are unchanged. Repeat measurements use one freshly installed tarball
and are saved before assertions under `docs/w16-runs`. Set
`FORGE3D_W16_SOAK=1 FORGE3D_W16_RUNS=3 FORGE3D_W16_RETAIN_REPORTS=1` when
running `npm run test:package-consumer:w16` to retain three sequential runs.
These local measurements cannot qualify either unavailable W00 machine.

The first optimized installed-tarball run **failed at 18.3 ms p95**, against
16.7 ms. It ran for 600,100.4 ms with 34,536 frames, all 64 keyframes and 693
selection sets. CPU peak was 42,918,791 bytes and GPU peak 42,770,544 bytes,
with zero GPU allocation after disposal. Update/upload/render p95 values were
7.0/0.8/12.6 ms. These observations show lower update cost but do not establish
a passing full frame or a reproducible explanation for the historical 14.2 ms.
The strict harness aborted at this failure; the requested second and third
repeats were not run. No outlier was excluded.

[The complete failing soak report](w16-runs/installed-1.json) and
[compact conformance report](w16-runs/oct09-conformance.json) are retained. Its
tarball SHA-256 is `c01ecf448f34c3740a2038d29fde0814b97c2ba2e392f12d0af4051e9acf39ab`.
[Runtime file hashes](w16-runs/oct09-runtime-files.json) bind all 269 dist/asset
files byte-for-byte to that installed tarball. The full temporary conformance
JSON repeats fixture manifests and selections; the compact report retains
observed hashes/counts and its complete-report digest.

October 9 checks: 1,078 unit tests, eight source/dist browser cases, the installed
conformance probes, 616 infrastructure contracts (one Unix-UID check skipped on
Windows), 15 parity checks, 11 documentation checks, 118 browser-harness checks,
API/type snapshots and the package contract pass. The ten-minute performance
gate failed. Hardware lane tests are synthetic contracts/dry runs only.

### Render-path investigation, 2026-10-10

The proposed GPU costs were tested independently and together: render directly
into the current canvas texture, and populate the integer picking attachment
only when a pick is requested. Four sequential 60-second probes used the same
camera interpolation, cold caches, point budget and complete timed frame work.
No other tests or builds ran concurrently. These are short diagnostic probes,
not ten-minute acceptance runs.

| Presentation | Picking attachment | Frames | Full-frame p95 | Render p95 |
| --- | --- | --- | --- | --- |
| Copy (existing) | Every frame (existing) | 3,470 | 10.4 ms | 6.8 ms |
| Direct | Every frame | 3,456 | 10.9 ms | 6.9 ms |
| Copy | On demand | 3,474 | 11.0 ms | 7.3 ms |
| Direct | On demand | 3,459 | 10.6 ms | 7.1 ms |

The prototype counters confirm zero presentation copies for direct mode and
zero picking-attachment frames for on-demand mode during traversal. Its ten
[source/dist correctness cases passed](w16-runs/render-path-conformance-oct10.json), including exact pixel equality, depth
ordering, alpha-zero points, circular point edges and picking/capture after
layer removal or disposal. No performance gain was observed on this host in
these probes. The production renderer and its public API were restored to
their exact `3c80bc7` bytes; neither speculative optimization is shipped.

[Raw probe reports](w16-runs/render-path-probes-oct10.json) retain all phase
timings, counters and allocations. The [prototype patch](w16-runs/render-path-prototype.patch)
applies to `3c80bc7` for reproduction in a separate checkout. Build TypeScript
and dist, serve the package with Vite on port 57883, then run
`node scripts/profile-w16-render-paths.mjs`. That script defaults to four
sequential one-minute probes; `FORGE3D_W16_PROFILE_MS` controls each duration.

The prototype's copy/continuous baseline was also below the limit. Its shorter
duration prevents a direct acceptance comparison with October 9. The short
probes cannot establish why the observations differ: previous host power,
thermal, driver and background-process state were not captured. A faster
observation therefore does not establish a runtime fix or invalidate the
earlier 18.3 ms failure. [Archived October 9 evidence](w16-oct09-evidence.json)
preserves that failure and its installed-package conformance and byte binding.

The new official installed-package repeats retain the unchanged renderer.
The harness now emits one progress record per minute, after recording the
timed frame and before requestAnimationFrame. This diagnostic sorting/logging
is between samples. Update, fetch/decode misses, upload and awaited GPU work
remain inside every measured frame; no measured stage is excluded.

### Repeated installed-package observations, 2026-10-10

Three sequential official ten-minute runs completed on local Windows/NVIDIA
Ampere with Chromium 148.0.7778.96. No other test suite or build ran alongside
the measured traversals. Each run created fresh dataset caches and kept the
full update/upload/awaited GPU path, including fetch and decode misses.

| Retained run | Duration | Frames | Full-frame p95 | Update/upload/render p95 | Verdict |
| --- | --- | --- | --- | --- | --- |
| [1](w16-runs/installed-20261010T121312939Z-1.json) | 600,063.3 ms | 35,105 | 8.3 ms | 1.8 / 0.3 / 6.9 ms | Passed locally |
| [2](w16-runs/installed-20261010T121312939Z-2.json) | 600,037.6 ms | 35,250 | 8.9 ms | 2.0 / 0.3 / 7.1 ms | Passed locally |
| [3](w16-runs/installed-20261010T121312939Z-3.json) | 600,058.3 ms | 35,278 | 9.4 ms | 2.4 / 0.4 / 7.3 ms | Passed locally |

All three checked all 64 keyframes, produced 693 selection sets, retained the
coarse root and drew between 299,520 and 299,994 points. Covered pixels were
103,748 / 98,430 / 102,016. Tracked CPU peak was 42,918,791 bytes in every run;
GPU peaks were 42,770,544 / 42,773,904 / 42,774,864 bytes, with zero after
disposal. All selection, coverage, memory and cleanup assertions passed.
Reports retain stage p50/p95/max summaries, not individual frame samples.

The measured tarball SHA-256 is
`f89a3fb82b6784d65c5bbf543a2d5cb2ffff5f95289034ad5553b19c009d653d`.
[Current runtime bindings](w16-runs/runtime-files.json) and the
[October 9 bindings](w16-runs/oct09-runtime-files.json) have the identical
269-file digest `907f7960530a51094c773d137ac612f965e9b77b08744942f5fdd9257de0f145`.
The camera harness changed only to emit the minute progress records described
above. [Installed conformance](w16-runs/conformance.json) also passed all
decoding, range, point/tile reference, picking and device-recovery assertions.
The [current evidence](w16-local-evidence.json) binds those reports and preserves
the previous failure separately.

These are three observed local passes with unchanged dist/asset bytes, not a
demonstrated performance fix. They do not explain the earlier 18.3 ms failure
or qualify either W00 physical machine. Local reproducibility therefore stays
open, the historical 14.2 ms acceptance claim remains withdrawn, and W16 stays
Partial with G02/G03/G04 at `P`.

October 10 checks: 1,078 unit tests, eight production source/dist browser cases,
three installed soaks and their preceding conformance checks, 15 parity checks,
11 documentation checks, 118 browser-harness checks, 616 infrastructure checks
and the package contract passed; the Unix-only infrastructure check was skipped.
The first package attempt failed the existing positive-decimal shell selector
test, and the isolated rerun also failed: `bash` resolved to the Windows Apps
alias. The complete rerun used the already installed Git Bash through a
process-local PATH and passed. No persistent environment or workflow setting
was changed.

### W00 hardware lanes remain pending

`w16-reference-discrete` routes to FW-LNX-NV-01 and `w16-reference-integrated`
routes to FW-WIN-I12-01 in the existing hardware matrix and `browser-hardware.yml`.
They are task acceptance lanes in `acceptanceLanes`; the existing 24 browser
support rows retain their scope.
The existing promotion, lab readiness, nonce-bound fixture, headed Chrome,
page/host attestation and finalization path is retained. W16 qualification also
requires the pinned W00 OS/driver observations and a complete ten-minute run.
Only matrix/contract validation is authorized here. FW-WIN-I12-01 remains
blocked on INF-00; FW-LNX-NV-01 is not provisioned. Neither profile has a run.

## Codec review remains open

`laz-perf@0.0.7` is pinned by npm integrity and the dependency lock. Its WASM
and web factory are unchanged except for an ESM export footer. Pinned upstream
Apache-2.0 text is supplied because the npm archive omits the license file.
Asset SHA-256 provenance and same-origin CSP checks are executable.

Boundary validation, allocation limits, cancellation, `finally` cleanup and
representative corrupt-input tests are implemented. These tests do **not**
complete the lock's mandatory security review before consumption. The codec
is exercised in experimental conformance probes; W16 is not accepted for
release consumption. Review still needs documented advisory triage, validation
of the binary/source provenance relationship, and review of malformed arithmetic
streams and worst-case worker CPU/allocation behavior. WASM trapping alone
does not establish those properties. No completed codec audit is claimed.

## Superseded evidence

[w16-initial-evidence.json](w16-initial-evidence.json) preserves the earlier
package hashes and ten-minute measurements as historical data. Its ten-node
chain, root-skipping 6.1% range probe and timing do not validate the revised
branching workload or current runtime. They must not be cited as W16 acceptance.

GPU picking, styles, actual device destruction/recovery, rejected replacement
retention, PNTS/RTC and B3DM scene coverage retain executable negative controls.
Relative/external tile URLs, cycles, transforms, cache pressure and cancellation
remain covered by the unit and installed-package tests.

## Completion hardening and security evidence, 2026-10-10

PR [#46](https://github.com/milos-agathon/forge3d-web/pull/46) carries the W16
runtime and acceptance work. W16 remains Partial and G02/G03/G04 remain P.
No plan requirements, W00 profiles or budgets were changed.

`7ea0b8c` and `bc532ba` add owned worker handles, 30-second default job
deadlines measured from enqueue, and immediate worker termination/replacement
on abort or timeout. Direct LAZ APIs also run behind an owned worker. Queued
jobs retain independent deadlines; downgraded unowned replacements cannot run
native decode. Native failures discard poisoned decoder instances and cleanup
cannot hide the original typed error. Source/dist infinite-WASM probes prove
typed REQUEST_CANCELLED and RESOURCE_LIMIT_EXCEEDED outcomes, queued real-LAZ
hash recovery and successful direct decoding. `356a264` fixes the test worker's
initialization-message race; [the original two timeout failures](w16-runs/hard-stop-initial-test-failure.log)
are retained. The complete rerun passed 47 W16 units and all ten browser cases.

`9b29d39` records host GPU state and other GPU processes, CPU load and power
plan every five seconds, including start/end and failed observations. New
reports validate actual sample gaps of at most ten seconds and bind the capture
to the exact job/package/fixture. The recorder writes unique batch filenames;
all earlier reports, including October 9 failures, remain intact.

[The laz-perf review](w16-laz-perf-review.md) now includes advisory triage,
an exact pinned-source/Emscripten rebuild matching npm's WASM and factory,
and [the final 260-case worker fuzz report](w16-security/fuzz-report.json).
All cases completed with valid output or a typed error, within recorded bounds,
and real-data recovery passed. **Independent sign-off remains pending**;
reviewer and approval date are unset. This agent has not approved the codec.

[The live lab observation](w16-security/hardware-pending.json) records zero
registered runners and no LAB_INFRA_READY variable. Both reference lanes are
pending, with no attested reports. No hardware dispatch, runner registration,
credential creation, protected-setting change or substitute qualification was
performed. A local passing run cannot qualify either reference host.

### Final local installed-package run with host capture

[The complete ten-minute report](w16-runs/installed-20261010T135319734Z-1.json)
passed on clean runtime commit `0e53772` with Chromium `148.0.7778.96`:
600,054.4 ms, 35,861 frames, **10.0 ms p95**, all 64 keyframes and 693 selection
sets. It drew 299,520–299,994 points and covered 94,616 pixels. Tracked CPU
peak was 42,918,791 bytes; GPU peak was 42,762,352 bytes, zero after disposal.
The complete update/fetch/decode/upload/awaited-GPU path remains timed.

The report embeds **121 host samples**, maximum observed gap **5,015.93 ms**.
Windows release was `10.0.26300`; NVIDIA RTX 3070 driver was `610.60`.
P-state observations were P8: 109, P5: 6, P0: 5, P3: 1. Graphics/SM clocks ranged
210–1,725 MHz; memory clock 405–7,001 MHz; GPU utilization 0–41%; device-wide
memory 880–1,560 MiB, including other GPU users. CPU load ranged 6.08–23.70%.
The power scheme remained `Lenovo Default` (GUID
`3a072fe5-9e0d-4cd1-ba25-1b4c556dba80`). Full GPU process tables are retained
per sample, including the test Chromium and other desktop/Python/browser/app
processes. No other agent tests or builds ran during the traversal. This shared
desktop observation does not establish an explanation for October 9 failures.

[Batch evidence](w16-runs/evidence-20261010T135319734Z.json),
[installed conformance](w16-runs/conformance-20261010T135319734Z.json), and
[runtime bindings](w16-runs/runtime-files-20261010T135319734Z.json) bind all
273 current dist/asset files to measured tarball SHA-256
`3d557369c4fbf99768e141c675c0e1edc22277736417b79c7442dc3d2e5dcf7f`.
Their runtime digest is
`6c046d4ace930909ec93b8efee9b89b14b89ef3fe2f5079beb6713eb773eef7a`.
Later evidence-only package contents can change the tarball digest; the runtime
bindings compare every measured dist/asset byte directly to the installed pack.

Final sequential local gates: **1,082 units** in 64 files; **15 parity checks**
with 53 lock-controlled consumers; **619 infrastructure checks passed**, one
existing Unix-UID check skipped on Windows; **47 W16 units and ten source/dist
browser cases passed**. The optional routine source soak was skipped because
the explicit installed-package command above executed the full ten-minute run.
No tests were weakened or removed. Build/API checks within the installed
consumer also passed. The final 260-case fuzz gate is bound in the security
review. PR CI is tracked on the current PR head; required check results must be
green before task 4 is complete.

### Review follow-up: unit timing risks

The independent spot-check reported one of four complete unit runs failing
`w16-provenance` and `w06-frames`, followed by three passing runs. No original
error output was captured, so neither a cold-disk timeout nor any other cause is
confirmed. That observation remains part of this evidence.

The W06 mux determinism test previously waited 1,100 ms for each container.
It now controls only `Date`, comparing the same complete MP4/WebM output bytes
at two fixed wall-clock values one day apart. Import, muxing, asynchronous
timers and `performance.now()` stay real, and `Date` is restored in `finally`.
All byte-equality, minimum-length and invalid-delta assertions are retained.
The provenance audit has a per-test 30-second cold-storage allowance while
still checking every native-source and fixture hash and every existing
manifest assertion. This does not alter W00 budgets, worker deadlines or any
performance gate.

Two fresh baseline full-unit runs passed, followed by four consecutive full
runs after these changes: 1,082 passes in 64 files each. The structured fourth
run recorded 291.3 ms for mux determinism and 322.3 ms for provenance. These
passing runs do not establish the original failure's cause.

This follow-up changes tests and evidence only. The shipped decoder, assets,
fuzz corpus and worker path are unchanged. Codec concurrency limits remain a
proposed sign-off condition for the independent reviewer; this agent has not
approved the codec. W16 remains Partial and G02/G03/G04 remain P.

### Retained review-follow-up soak failure

The clean `8094575` rerun passed all 1,082 units, 15 parity checks, 619
infrastructure checks (one existing skip), 47 W16 units and all ten source/dist
browser cases. Installed conformance and API/build checks passed, but
[the ten-minute soak](w16-runs/installed-20261010T182246586Z-1.json) failed:
600,086.9 ms, 29,276 frames, **33.7 ms p95** against the unchanged 16.7 ms limit.
[Its failure log](w16-runs/installed-20261010T182246586Z-failure.log),
[batch evidence](w16-runs/evidence-20261010T182246586Z.json),
[conformance](w16-runs/conformance-20261010T182246586Z.json), and
[runtime binding](w16-runs/runtime-files-20261010T182246586Z.json) are retained.

All 273 runtime/asset hashes match the earlier passing batch exactly, with
digest `6c046d4ace930909ec93b8efee9b89b14b89ef3fe2f5079beb6713eb773eef7a`.
The browser, 1920x1080 viewport, fixture and camera harness also match. The
observed package SHA-256 is
`436cf662e16a1dfe148255b3612e2f1cf0f41f52d55bc1cd8ec48902209d8d5c`;
documentation-only package contents differ. Update/upload/render p95 values
were 20.2/1.3/12.8 ms. Tracked CPU and GPU peaks were 42,918,791 and 42,770,544
bytes, with zero GPU bytes after disposal. Coverage, all 64 keyframes, 693
selection sets and real-data counts passed.

The report retains 121 host samples, maximum gap 5,041.11 ms. Host CPU load
ranged 20.41–100%, mean 86.07%, versus mean 11.84% in the passing batch.
RTX 3070 driver `610.60` was observed in P8 96 times, P5 10 times and P0 15
times. Graphics/SM clocks ranged 210–1,725 MHz, memory clocks 405–7,001 MHz,
GPU utilization 0–100%, and total device memory 1,165–1,804 MiB. The power
scheme remained Lenovo Default. Full GPU process tables are retained.

A subsequent read-only CPU process probe found Python PID 7212 consuming
roughly 20 cores, alongside other Python and rustc activity. A later
[post-run snapshot](w16-runs/host-processes-after-20261010T182246586Z.json)
records changed process activity. These post-run snapshots do not attribute
individual processes to historical CPU samples or prove causation. No other
tests or builds were started by this agent during the soak; competing desktop
processes were not stopped. The failed observation remains valid and does not
establish an explanation for October 9 failures.

### Confirmed native-audit harness timeouts

CI run [38076912877](https://github.com/milos-agathon/forge3d-web/actions/runs/38076912877)
on `aa91f6c` failed the W16 native-camera integrity test with the exact error
`Test timed out in 5000ms`; its recorded duration was 5,233 ms. The complete
[failed job log](w16-runs/ci-aa91f6c-native-camera-timeout.log) is retained.
The W06 wall-clock test and W16 provenance test passed in that run. Browser
Preflight was skipped by the failed build dependency; this run is not green.

The camera test parses one 6.33 MB manifest and checks 132 unique camera
selections against 46,831 native key/count/quantized-SSE records. Datasets and
hierarchy pages are already reused. A per-test 30-second harness allowance
keeps every comparison intact; it does not change traversal code or the W00
frame-time gate.

The subsequent local full-unit run exposed another confirmed five-second
timeout in the inherited W15 native provenance audit, recorded at 7,816 ms.
[That failure output](w16-runs/unit-native-audit-timeout-followup.log) is also
retained. This audit hashes all 33 frozen suites and their imported sources,
checks 68 concrete ports, and cross-checks available Git history. It receives
the same per-test 30-second filesystem/subprocess allowance. Global Vitest
timeouts, all audit assertions, history checks and runtime budgets are unchanged.

After both targeted allowances, a fresh sequential run passed all 1,082 units
in 64 files, with the W15 audit at 7,813 ms and W16 camera audit at 3,500 ms.
Parity passed all 15 checks with 53 lock-controlled consumers; infrastructure
passed 619 checks with one existing Unix-UID skip; W16 passed 47 units and all
ten source/dist browser cases. The optional source soak remains disabled;
at this checkpoint the explicit installed-package soak above was a failure,
which remains retained alongside the subsequent quiet-host retry below.
No shipped runtime, asset, fuzz corpus or worker-path bytes changed. Current
PR CI still requires a green run on the pushed final head. Independent codec
sign-off and both exact W00 hardware lanes remain pending. W16 remains Partial
and G02/G03/G04 remain P.

### Quiet-host retry after the confirmed audit timeouts

After the shared host had repeatedly reported 87–100% CPU load, a later
five-second observation fell to 8.11%. Three further observations were
10.95%, 13.13% and 14.95%. Only then was one additional installed-package
run started on clean `581ca90547a34bed57f1275c5636f0c6603ce8ef`, using the
unchanged `FORGE3D_W16_SOAK=1 npm run test:package-consumer:w16` gate.
No other agent tests, builds or CI polling ran during that command. No
competing process was stopped and no power plan or GPU setting was changed.

[The complete report](w16-runs/installed-20261010T203221986Z-1.json) passed:
600,074 ms, 35,272 frames, **10.5 ms p95**, against the unchanged 16.7 ms
limit. [Its stdout](w16-runs/installed-20261010T203221986Z-retry.log),
[batch evidence](w16-runs/evidence-20261010T203221986Z.json),
[installed conformance](w16-runs/conformance-20261010T203221986Z.json), and
[runtime bindings](w16-runs/runtime-files-20261010T203221986Z.json) are retained.
All 64 keyframes and 693 selection sets were exercised; the workload remains
one million points, with 299,520–299,994 admitted and 100,938 covered pixels.
Update/upload/render p95 values were 3.3/0.5/7.6 ms. Tracked CPU and GPU peaks
were 42,918,791 and 42,774,384 bytes, with zero GPU bytes after disposal.

There are 121 host samples with maximum gap 5,015.82 ms. Windows release was
`10.0.26300`, Chromium `148.0.7778.96`, and NVIDIA RTX 3070 driver `610.60`.
P-state counts were P8: 71, P5: 18, P0: 31, P3: 1. Graphics/SM clocks ranged
210–1,980 MHz and memory clocks 405–7,001 MHz. GPU utilization ranged 2–100%
(mean 24.45%); device-wide memory was 1,121–2,246 MiB, including other users.
CPU load ranged 11.28–20.84% (mean 16.64%). The power scheme remained
Lenovo Default, GUID `3a072fe5-9e0d-4cd1-ba25-1b4c556dba80`. Complete GPU
process tables retain other desktop/Python activity as well as the test browser.

The measured package SHA-256 is
`24f7d66de5f0507bce8d66fa83d3c4676d2003749c0482e623160571748f8c97`.
All 273 runtime/asset hashes have digest
`6c046d4ace930909ec93b8efee9b89b14b89ef3fe2f5079beb6713eb773eef7a`,
identical to both earlier October 10 batches. Fixture, camera harness, viewport
and browser also match. Only documentation changed package contents. The
33.7 ms failure and every October 9 failure remain valid observations; this
retry neither establishes causation nor explains October 9 variation. No
runtime performance fix is claimed.

Measured-head [CI run 38078029518](https://github.com/milos-agathon/forge3d-web/actions/runs/38078029518)
passed Build And Contract Tests, Browser Preflight and optional WebKit. It
passed all 1,082 units and 619 infrastructure checks (one existing skip);
Chromium passed 258 cases with nine existing skips, Firefox 263 with four.
The worker fuzz gate retained 260 cases: 120 valid, 140 typed errors, zero
untyped; maximum decode time 156.4 ms and observed WASM heap 7,274,496 bytes,
with real-data recovery. The fresh local 15-check parity gate and 47-unit /
ten-browser-case W16 gate are bound in the batch evidence; their tested sources
are identical to the measured head. Later evidence-only PR heads still require
their own green CI result, tracked on the PR.

The remaining acceptance items are independent laz-perf sign-off (reviewer
and date unset) and both attested W00 reference hardware lanes. The lab remains
unready with zero registered runners. This local Windows run is not either
reference hardware lane. W16 remains Partial and G02/G03/G04 remain P.

### Portable stdout hash bindings

The Windows stdout files were retained with CRLF line endings, but Git's
default text normalization stored LF blobs for four of the five retained
logs. No text or measured values differ. Original logs and every JSON report
remain unchanged. Additive [raw stdout archives](w16-runs/stdout-archives.json)
now preserve those retained file bytes, protected by a narrowly scoped
`-text -diff` attribute. The manifest records each raw SHA-256, its prior Git
blob SHA-256 and the exact CRLF-to-LF difference, if any.

For the latest passing run, the immutable batch evidence's stdout hash is
`7f03ddb088e8f405b7b7cb9cb0a7b157d1ba3f442b30851cc100b0486de2a976`.
It identifies the 2,321 captured bytes in
[the raw archive](w16-runs/raw-stdout/installed-20261010T203221986Z-retry.log).
The original Git-normalized text is 2,292 bytes with SHA-256
`daede82cfb0651e7850d004bfb64244e3e29c3bc8f5af379eeb73a222ba72616`:
the only difference is 29 CR bytes. Platform-independent capture-hash
verification should follow the manifest's `rawArchive` path. Copies of the
failed soak, initial hard-stop failure, native audit failure and full failed
CI log are also retained in that directory. All archive hashes are checked
against their staged Git blob bytes before publication.

This storage correction changes no runtime, asset, fixture, camera harness,
test assertion, budget or existing report. The final archive commit still
requires its own green PR CI. Independent codec sign-off and both exact W00
hardware lanes remain pending; W16 stays Partial and G02/G03/G04 stay P.

### Retained final-head live-download failure and bounded transport retries

[CI run 38089675110](https://github.com/milos-agathon/forge3d-web/actions/runs/38089675110)
on `a5d3a8f4e9cdba1cfcafd6ff2b40961b51064638` failed in the last W14 live
dataset step, after the unit, package, infrastructure, installed W16 and worker
fuzz gates had passed. The [complete raw job log](w16-runs/raw-stdout/ci-a5d3a8f-remote-dataset-failure.log)
is retained as 772,592 bytes, SHA-256
`4a158502d07a72d32ca04bad2c4d32bf32562683f45990a83e44f674f4da0db7`.
The fuzz result was 260 cases, 120 valid, 140 typed errors, zero untyped,
266.4 ms maximum, 7,274,496 bytes observed WASM heap, and successful real-data
recovery. Required Browser Preflight and optional WebKit did not run because
their build dependency failed.

Nine remote datasets passed their exact size and SHA checks. The tenth,
`swiss-land-cover`, failed with `IO_ERROR`, `kind: asset-io`, reason
`TypeError: terminated`. Its stream ended after approximately 70.24 seconds,
before the unchanged 120-second fetch deadline. The step ran from
22:27:18 to 22:28:48 UTC on October 10; CI recorded exit code 1 and normal
cleanup, without a timeout annotation. This is an observed transport failure,
not a recorded runner timeout. Partial body chunks are local until complete
size/SHA verification; the harness also disables persistent caching.

The live harness now permits at most three attempts for only that exact
typed error, the current asset name, and that exact reason. Each attempt uses
a fresh 120-second signal, with 1- and 2-second backoffs. Every failed attempt
is printed and retained in the JSON report, including exhausted or fatal
attempts. Integrity, HTTP, validation, cancellation, resource and other
transport errors remain fatal. All ten real default URLs, full byte counts
and SHA assertions remain required; no fixture fallback is used.

Eight negative-control unit tests exercise the real registry body/verification
path to prove interrupted-stream recovery, fatal corrupt bytes even when a
later response would be valid, exhausted retries, and no retry of resource,
cancellation, HTTP and other transport errors, with a separate synthetic
mismatched-asset classification check. A ten-minute
bound applies to the whole remote CI step. Build-job scheduling allowance is
40 minutes because preceding checks consumed about 28 minutes 20 seconds in
the failed run, leaving insufficient retry time under its former 30-minute
allowance. This margin does not change a test timeout, decoder deadline,
soak duration or W00 budget. This correction changes no shipped runtime,
asset, fixture or fuzz corpus; the retained 10.5 ms clean soak still binds the
same runtime/asset hashes. Later CI status is tracked on the PR. Codec
approval and both exact hardware reports remain pending, with W16 Partial
and G02/G03/G04 P.

### Cold setup and fixture audit follow-up

The subsequent full local unit run captured two timeout failures: the W06
mux determinism test took 5,412 ms against its five-second limit, and W16's
fixture provenance audit took 32,154 ms against its thirty-second limit.
[The raw failure log](w16-runs/raw-stdout/unit-cold-setup-timeout-followup.log)
is retained as 8,492 bytes with SHA-256
`4245f3299dd83f9378420fbe0c3b1fd1ccdd72b4615e9ac346798ec7ad9f2f90`.
These failures establish timeout exhaustion; they do not establish a specific
CPU, disk or antivirus cause.

W06 now imports the actual `mediabunny` dependency during module setup,
before its functional test deadline. The test still creates real muxers at
two dates a day apart, checks every output byte and validation error, and
restores Date. W16 uses at most sixteen asynchronous reads per batch, rather
than serial synchronous opens: 1,903 fixture entries (22,081,709 bytes), plus
21 independent native-source entries (233,645 bytes), totaling 1,924 reads
and 22,315,354 bytes. All 21 native-source hashes and every fixture hash/length
remain required. No timeout or assertion is relaxed by these changes.

The first audit refactor incorrectly applied a fixture length assertion to
native-source entries, whose manifest has no length field; that development
failure is retained in [its raw log](w16-runs/raw-stdout/unit-async-audit-refactor-failure.log),
6,399 bytes, SHA-256
`227541bf0f823fc8944f4715d0020dc63d6ca6003690613a05309add115e865a`.
The corrected test selects the proper manifest field for each group and
preserves the original group-specific checks. The complete subsequent suite
passed all 1,090 tests (including eight new transport negative controls).
All earlier failures remain in the record. These test-harness changes do not
alter runtime or fuzz bytes, hardware profiles or W16 acceptance status.

### Retained IBL cache assertion timeout

[CI run 38092372800](https://github.com/milos-agathon/forge3d-web/actions/runs/38092372800)
on `3704fd21e9b8613dcad8027279e185d742a6501c` built WASM successfully, then
failed one unit: IBL cache byte round-trip took 5,261 ms against its unchanged
five-second limit. W06, the W16 provenance audit (831 ms), and all eight
transport negative controls passed. The [complete raw failed job log](w16-runs/raw-stdout/ci-3704fd2-ibl-cache-timeout.log)
is retained as 177,639 bytes, SHA-256
`bfd7258942208738f84a8135071f0f9b672c53d049d7da50dec557655004563c`.

The low-tier IBL payload contains 3,341,312 bytes. Its three equality checks
previously materialized 6,682,624 numeric JavaScript array entries before
Vitest compared them. Those assertions, and the equivalent large prepared
cache-hit comparison, now use native `Buffer.compare` over the complete
`Uint8Array` views with explicit byte offsets and lengths. Length checks,
every payload byte, backend/miss/hit/metadata assertions, real Response
serialization, hashing and corrupt-cache negative controls remain exercised.
No test timeout, runtime, fixture or acceptance budget changes. The fresh
complete local suite passed all 1,090 tests after this correction; final-head
CI must still pass. The original failed run remains a failure in the record.
