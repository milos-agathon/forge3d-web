# W16 implementation and acceptance evidence

W16 acceptance is pending. G02, G03 and G04 remain `P`: the runtime and local
conformance tests exist, but the pinned W00 physical reference-profile runs and
the mandatory laz-perf security review are open. The original required outcomes
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

### Revised local run, 2026-10-07

Chromium 148.0.7778.96 on Windows/NVIDIA Ampere passed the static installed
tarball checks, including the complete ten-minute run. The observed tarball is
`a6a6e54c20c1c02c38e517858ed998e3a4a7b46c3e65ad61a8f62cc2ef49c994`.
All 269 current dist/asset files match that tarball byte-for-byte; documentation
updates after the run are excluded from the runtime binding.

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

These are local preflight results against the discrete target limits. They do
not qualify either pinned W00 physical reference machine or complete the codec
security review.

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
