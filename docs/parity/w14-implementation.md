# W14 — CRS and dataset foundation

W14 closes G01 and E06 with public TypeScript APIs, a real PROJ WASM worker,
the complete native dataset registry, and verified browser storage. The
[package guide](../../crates/forge3d-web/docs/crs-datasets.md) describes use,
deployment, precision, grid requirements, cancellation and resource lifetime.

## Native evidence and browser outcomes

The six CRS/dataset source and test blobs were read from reconciliation commit
`1f4084af428dc699bdcd108b029736cb73903926` and compared byte for byte with
deep-native commit `bf8db93233e5158f6d226991fc5d230832c2d806`. Frozen copies
are in `crates/forge3d-web/tests/golden/w14/native/`.
[The coverage record](w14-native-test-coverage.json) assigns every test
definition from the three native suites to a named browser test. Its unit test
checks complete definition coverage, source digests, named ports and public
exports. Regeneration fails if the two native source snapshots diverge.

Native Python/NumPy/backend detection becomes ESM, float arrays and explicit
worker capability errors. Filesystem paths and local checkout lookup become
package-relative HTTP URLs and content-addressed browser caches. Remote URLs
retain the native Git LFS media endpoint but freeze the baseline commit for
reproducibility. The registry preserves every native remote name, kind,
description, filename and SHA-256. Small verified fixtures exercise the three
format-specific fetch helpers; remote file decoding belongs to W15/W16.
The native boundary fixture uses normalized terrain coordinates and is marked
as such, without an invented EPSG code.

## Implementation

- `CrsTransformer`: EPSG/OGC, PROJ, WKT1/WKT2 and PROJJSON metadata;
  coordinate tuples and float buffers; authority/XY order; GeoJSON topology,
  holes, collections, null geometries, IDs/properties and recomputed bounds.
- W02 message-port pool: one owned module worker, bounded queue, cancellation,
  copied caller buffers, typed errors, synchronous idempotent disposal.
- Direct PROJ C API: explicit native contexts/PJ handles and coordinate
  allocations released in finally blocks. Networking is disabled in every
  context. `ONLY_BEST=YES` and `ALLOW_BALLPARK=NO` prevent approximate
  fallback; required missing grids return structured names and errors.
- `VectorLayers.addGeospatial()` commits after successful conversion, preserving
  feature IDs and elevation. A terrain dataset's optional CRS supplies the
  target. The asynchronous label bridge supports all W13 coordinate forms.
- `DatasetRegistry`: all 12 native records, safe URL resolution, generic and
  kind-specific verified fetches, exact bundled DEM/boundaries, non-executable
  NPY decoding, progress, cancellation and diagnostics.
- Shared verified store: expected size/digest checks after network reads and
  on every cache hit, including a valid cache frame with wrong asset contents;
  corrupt entries are removed. Offline misses are explicit. Memory caches
  are bounded; disposal preserves shared persistent entries.

The default CRS admission limit is 256 MiB, per-asset limit 32 MiB, and batch
limit one million points. Diagnostics account for asset copies, native heap,
queued coordinate reservations and worker/pending counts. Dataset memory cache
is bounded at 64 MiB with a 256 MiB per-asset limit. Neither service allocates
GPU resources. Native heap stability is tested across repeated successful and
failing operations. Geometry topology depth and point counts are bounded.

## Dependency and license review

The dependency remains exactly `proj-wasm@0.1.0-alpha9`, using the W00 tarball
SHA-256/SRI. `prepare-w14-assets.mjs` compares each installed upstream file
against the verified archive. Normal packaging verifies checked-in file
digests against the W00 dependency lock and retains all assets in the emitted
package manifest. The module, WASM, database and configuration are unmodified.
PROJ database metadata reports PROJ 9.8.1, EPSG v12.029 and PROJ data 1.24.

The conus grid is frozen as `proj-data-conus-v1`, 173029 bytes, SHA-256
`44611d823c48e5347500ee6afe40ff33d2b88cf817bf59f705ed4a4c3bd687d7`.
The preparation script rejects changed grid bytes. The package retains
proj-wasm's MIT LICENSE, PROJ's upstream COPYING notice, and the NOAA
public-domain attribution from PROJ-data 1.24.0. All notices are digest-pinned.
Additional grids require caller-supplied version and SHA-256; optional/null
grids are rejected. The conus fixture does not satisfy NADCON5 operations:
the actual best-grid failure is exercised as a negative control.

Security review on 2026-10-06 covered malformed CRS/PROJJSON/WKT, invalid
shapes/nonfinite values, cyclic/oversized geometry, grid-name validation,
untrusted URL traversal, HTTP failure, byte limits, network/cache digest
poisoning, cancellation, worker absence, disposal and GPU device loss.
`npm audit --json` found seven existing development-tool advisories
(Vitest/mocker, nanoid, postcss, sourcemap, tar, yaml); none names proj-wasm
or its dependency chain. The package adds no bare runtime npm dependencies.
This is an experimental upstream dependency with maintenance risk, as required
by the W00 lock; the review does not change that classification.

## Verification

The fixture generator uses independent pyproj 3.7.2 / PROJ 9.5.1 controls:
32 WGS84 points in Web Mercator and UTM 32N, Fuji in UTM 54N, southern
hemisphere UTM 32S, authority axis order, WKT/PROJJSON, and three US points
through the real pinned grid. Required tolerances are 1e-7 geographic degrees,
0.01 m projected and 0.02 m projected round trips.

The browser suite exercises source and emitted modules, all GeoJSON geometry
types, vector/label transactionality, persistent offline cache, expected-digest
poisoning, real grid corruption, setup/worker cancellation, memory admission,
backend absence, disposal and an actual destroyed GPU device.

`test:package-consumer:w14` packs and installs a fresh tarball into a temporary
consumer outside the checkout. Its TypeScript client imports only
`@forge3d/web`. A plain static server runs the emitted worker under strict
`script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'`.
The browser warms immutable module URLs and verified IndexedDB entries,
disables all networking, creates a fresh projection worker and transforms
coordinates with the grid, then reads both native datasets offline. HTTP
module caching is necessary as well as persistent asset caching. No runtime
CDN or remote requests are allowed.

Measured tarball results, precision, live/disposed resource diagnostics and
offline outcomes are written to `test-results/w14-package-consumer.json`.
The CI workflow runs this isolated package check. This W14 evidence does not
change the broader browser release-support or physical hardware matrix.

Verification commands:

The final run passed 933 unit tests, eight Chromium W14 browser cases, public
API/declaration checks, nine documentation link checks, the emitted package
contract, and the isolated strict-CSP/offline tarball consumer. Observed maxima
were 9.313225746154785e-10 m projected, 1.4210854715202004e-14 degrees
geographic, 9.313225746154785e-10 m projected round trip, and zero grid error
against the independent oracle. The live worker reported 14197342 asset bytes,
a 16777216-byte WASM heap and zero GPU allocations; settled disposal reported
zero workers, pending calls, assets, heap and reservations.

The aggregate `test:package` reaches unrelated infrastructure tests that need
Windows symlink privileges unavailable to this process. Three tests fail with
`EPERM` creating file/directory symlinks in
`firefox-viewer-contract.test.mjs` and `runner-distribution.test.mjs`;
these files are unchanged from the starting commit. Selecting Git's Bash in
the command's PATH resolves the separate WindowsApps Bash-selector failure.
The browser-harness suite passes all 118 tests; infrastructure then reports
606 passes, three symlink failures and one skipped test. The W14 spec inventory
and automatic shared WebGPU guard pass all 13 classifier tests. The independent
`package-contract.mjs` passes. No host security settings were changed.

```powershell
$env:CARGO_TARGET_DIR = 'C:\devin-target\forge3d-web'
npm run build:wasm
npm run build:ts
npm run prepare-dist
npm run test:unit
npm run test:api
npm run test:docs
npx playwright test tests/playwright/w14_foundation.spec.ts --project=chromium-preflight
npm run test:package-consumer:w14
npm run test:package
npm run verify:parity
```
