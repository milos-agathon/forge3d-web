# W16 implementation and evidence

Implementation covers G02-G04. The fresh worktree starts at W15 commit
`f0287e5b1594542635f8b088e2ae88d7be8ec435`; W15 is needed for B3DM's plain-glTF
decoder. No previous completion claims were used as verification.

## Independent references

`tests/fixtures/w16/copc-ept-tiles-v1.json` pins fixture bytes, deepest native
sources at `bf8db93233e5158f6d226991fc5d230832c2d806`, the upstream COPC/LAZ
commits and laspy 2.7.0/lazrs 0.8.2 expectations. The original Autzen LAZ has
110,000 points; the original ellipsoid COPC has 100,000, with 66,272 in its root
chunk. Source and installed browser decoders compare exact Float64 coordinate
and RGB byte hashes with the independent decoder.

W00's million-point, eight-level, 64-camera workload is `workload-ept`. It
resamples real Autzen coordinates into valid octree cells using explicit affine
scales and encodes binary records independently in Python. Its ten positive
data nodes total exactly 1,000,000 points. Each decoded node's coordinates and
colors are hash-checked. The pinned native public traverser generates camera
keys/counts and SSE records. SSE is recorded at nine decimal places to exclude
irrelevant last-bit differences between NumPy and JavaScript transcendental
functions. Bounds are checked against the 1e-5 dataset-span tolerance.

The native Python `open_copc` wrapper never sets `_is_copc` and falls back to a
flat LAS dataset. Golden generation constructs native `CopcDataset` directly.
Other discovered native defects are intentionally fixed in the browser:
hierarchy page references/empty parents are retained; format-specific LAS RGB
offsets and LAS bounds offsets are correct; priority visits the highest entry;
budgets remain strict even inside a node. The native replacement selection is
preserved separately from additive COPC/EPT rendering.

`tests/test_copc_laz_fixture.py` is a proxy. Canonical native Section 18 tests
are included in the reference set, alongside point GPU/LOD and tile parse/SSE
tests. The independent real-fixture browser tests replace extension-only native
construction gates with actual decoding, drawing and integer readback.

## Decoder review

`laz-perf@0.0.7` is pinned by npm integrity and W00 dependency lock. Its web
factory/WASM are copied without modification except an ESM export footer.
The npm archive omits a license file; Apache-2.0 text is copied from pinned
upstream and shipped with per-asset SHA-256 provenance. Runtime codec requests
stay under `script-src 'self'`, `worker-src 'self'` and `connect-src 'self'`.

Boundary validation rejects unsafe 64-bit offsets, short headers/VLR/pages,
bad record lengths/counts, corrupt layered chunk counts/stream lengths, invalid table spans,
nonfinite data and budget overflow. Native heap allocations and decoder objects
are freed in `finally`. The WASM runtime isolates native memory and traps are
reported as typed failures. Decode yields between record batches to deliver
cancellation; workers provide the preferred isolation for large/untrusted
files. WASM does not guarantee every malformed arithmetic stream can be
recognized by this experimental upstream decoder; valid counts/hashes and
representative corrupt cases are tested, without claiming a codec audit.

## Verification records

Executable verification is in unit tests, source/dist Playwright and
`scripts/test-w16-package-consumer.mjs`. Installed output generates
`test-results/w16-package-consumer.json` with tarball hash, browser version,
exact decoded data, range bytes, CSP/off-origin requests, drawing, picks,
device destruction/recovery and zero disposal allocation. The explicit
ten-minute run generates `test-results/w16-soak.json` with actual adapter,
1080p frame p95, 64 visited keyframes, selection changes and CPU/GPU allocation.

W00 budgets for this fixture are 1.5/1 GiB CPU and 3/2 GiB GPU, with p95
16.7/33.3 ms for reference discrete/integrated profiles. The local renderer
uses a stricter 256 MiB GPU limit. The actual host is Windows; it cannot attest
the pinned Ubuntu/Vulkan reference-discrete or Iris Xe reference-integrated
machines. Local Chromium preflight results do not qualify those hardware rows.

### Local run, 2026-10-07

[Stored results](w16-local-evidence.json) record Chromium 148.0.7778.96 on
Windows with an NVIDIA Ampere adapter. Both the final conformance tarball and
the ten-minute tarball are identified by SHA-256. All 152 emitted runtime modules
and self-hosted assets are byte-identical between them; documentation and the
additional full-COPC assertions were finalized after the soak.

| Check | Measured result |
| --- | --- |
| Full unit suite | 1,076 passing tests across 64 files; 41 W16 tests |
| Source/dist browser examples | Eight passing cases; the explicit installed ten-minute run is recorded below |
| Installed real data | LAZ 110,000; COPC 100,000 across all five ranged chunks; EPT 128; workload EPT 1,000,000 |
| Independent coordinate/color hashes | All original-file COPC chunks, LAZ, EPT and ten workload nodes match laspy/lazrs/byte-defined expectations |
| Initial ranged COPC view | 6.1154% of fixture bytes; every body request uses Range and receives 206 |
| Native camera selection | 64 workload camera records match; point/tile SSE and bounds contracts pass |
| 1080p sustained traversal | 600,053.1 ms; 33,393 frames; frame p95 10.2 ms; seven selection sets |
| Tracked peak allocations | CPU 78,000,889 bytes; GPU 56,883,312 bytes; GPU returns to zero after disposal |
| Final-frame rendering | 430,640 covered pixels, preventing blank-frame success |
| GPU workflows | Exact RGB/elevation/classification samples, grayscale within one quantization LSB, aligned integer picks, actual device destruction/recovery and preserved rejected replacements |
| Package gates | API/type snapshots, production example, 11 doc checks, 118 browser-harness checks, 609 infrastructure checks and package contract pass; one Unix-UID check is inapplicable on Windows |
| Dependency/provenance | Parity gate passes; 49 pinned fixture/codec streams match Git index bytes |

The explicit installed soak ran to completion. The normal Playwright command
skips its ten-minute case unless `FORGE3D_W16_SOAK=1`; this keeps routine runs
short while preserving a separate executable acceptance check. W14/W15 browser
regression checks also passed all 26 cases.

## Coverage mapping

| Native behavior | Browser implementation / evidence |
| --- | --- |
| COPC LAS/VLR/hierarchy/chunks | `copc.ts`, `pointcloud-las.ts`, `laz-decoder.ts`; original COPC coordinate/color hashes and ranged initial view |
| EPT schema, page refs, binary/LASzip | `ept.ts`, `PointSource`; asymmetric reordered schema, million-point workload, shared-page cancellation/offline tests |
| Point buffers, colors, viewer stride | `PointBuffer`; exact six/twelve-float interleaves, defaults and transferable ownership |
| LOD/SSE/budgets/stats | heap traverser, adaptive controller, transactional layers; pinned native camera records and sustained workload |
| GPU style/picking/loss/pressure | compact instanced renderer; covered RGB negative controls, integer picks, actual destroyed device, retained replay and bounded allocation |
| Tile parsing/SSE/transforms/cache | `Tileset`, `TilesetTraverser`, `Tiles3dLayer`; native camera records, external URLs/cycles, shear/region bounds |
| PNTS/B3DM | `tiles3d-content.ts`; real byte-defined RGB/quantized/RTC points and W15 GLB triangle with batch metadata |

OGC source: [3D Tiles 1.0 specification](https://docs.ogc.org/cs/18-053r2/18-053r2.html).
COPC source: [COPC specification](https://copc.io/).
EPT source: [Entwine specification](https://entwine.io/entwine-point-tile.html).
