# W14 — CRS and dataset foundation

W14 implements G01 and E06 with public TypeScript APIs, a real PROJ WASM worker,
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
pin data-repository commit `043a032cf00bee20a2299514484f811de8a53e9f` with size/digest checks. Five
raster assets use Git LFS media; five ordinary Git blobs use the raw endpoint.
The registry preserves every native remote name, kind, description and filename.
Two stale native hashes are exposed as `nativeSha256`: Fuji buildings had a
CRLF digest while Git serves LF; sample CityJSON differs from its registry digest.
Fetch hashes pin the actual committed native blobs. `remote-storage.json` records
data-repository tree `043a032cf00bee20a2299514484f811de8a53e9f`, storage and blob IDs.
A live gate fetches all ten datasets without mocks and checks complete bytes.
Bundled names work through all kind helpers, matching native behavior. Remote
file decoding belongs to W15/W16.
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
- Ordinary `await runtime.setVectorLayers(layers)` automatically projects
  CRS-tagged input into the retained terrain CRS and affine frame. GDAL pixel
  centers map to the renderer's centered X/Z sample grid, including rotation.
  Failed/superseded ingestion leaves committed layers intact; owned workers
  are disposed. Callers retain source coordinates. `addGeospatial()` and the
  label bridge also align through a terrain dataset. Explicit CRS-string
  targets continue to return absolute projected coordinates.
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
package manifest. The original module, WASM, database and configuration remain
unmodified. Packaging checks the module digest before embedding its factory
declaration into the application worker. Development uses the same checked
declaration after transpilation. The worker compares that declaration against
verified reference bytes before invoking it. No PROJ asset URL is imported as
executable code, so a hostile second response or injected top-level asset code
cannot run. Build verification evaluates no third-party module. The emitted
worker is covered by the package asset manifest. The application worker and its
ordinary same-origin dependencies remain the host's trusted code.
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
forward and inverse controls for 32 points in Web Mercator, UTM 32N and
UTM 32S, plus Fuji UTM 54N. Rounded projected inverse inputs have independent
geographic expectations. Geographic error measures this oracle comparison.
Published EPSG Guidance Note 7-2 examples supplement those controls (Web
Mercator and forward/inverse British National Grid). The original W00
`crs-epsg-v1` contract record is restored exactly and tested against its frozen
pre-W14 copy; supplemental controls have their own UTF-8/LF provenance/hash.
Authority axis order, WKT/PROJJSON and three US grid points are also tested,
including an ordinary CRS-to-CRS conversion using the named bundled grid. Required tolerances are 1e-7 geographic degrees,
0.01 m projected and 0.02 m projected round trips.

The browser suite exercises source and emitted modules, all GeoJSON geometry
types, vector/label transactionality, persistent offline cache, expected-digest
poisoning, real grid corruption, setup/worker cancellation, memory admission,
backend absence, disposal and an actual destroyed GPU device. A real terrain
render compares automatically projected vectors with independent local control
positions and explicit heights from three raster samples: both RGBA and pick
IDs match, with nonempty coverage. An asymmetric slope and off-center summit
make both axis orientations observable. Reversing either axis changes the
render and produces height errors greater than 5 m against the control samples.
Absolute
projected-coordinate negative controls have zero visible picks. Terrain-aligned
labels, ingestion failure and superseding cancellation are asserted as well.

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

The earlier 933-test pass was checkout-dependent: the fixture digest used CRLF
bytes while Git checks out LF. Default remote dataset URLs also returned 404.
The previous completion claim is withdrawn. Follow-up review also found that
the LF fixture's free text contained double-encoded Unicode, downloads used a
mutable branch, the rendered terrain was symmetric, and the module check ran
after import. Commit `57b96e6` fixes all four. Explicit UTF-8 reads preserve degree
symbols even when the generator runs with Windows legacy encoding; repeated
regeneration produces the same fixture bytes.

On 2026-10-07, `57b96e6` was verified in a new detached checkout with `npm ci`,
fresh package outputs and a full build, including recompilation of both Rust
crates. All 944 unit tests, twelve Chromium W14 cases, public API/declaration
checks, nine documentation checks, fifteen parity tests, the prepared emitted
package contract and the strict-CSP/offline installed consumer passed. The
hostile-code controls prove that raw PROJ assets are never imported as scripts,
injected top-level bytes are rejected without execution, and a changed embedded
factory is rejected before its body executes. The live integration gate
downloaded all ten remote datasets from the immutable data commit using default
settings and verified 319872562 bytes against the pinned sizes/digests. Both
media and raw endpoints return HTTP 200 with `Access-Control-Allow-Origin: *`.
CI runs both the offline installed-package and live dataset gates.

The corrected fixture is UTF-8/LF, SHA-256
`14876bb676e5860f33384368e74e50251af6ad3d4ffff0f8b2371e2d5c2234ea`.
The independent and published controls measured maximum errors of
0.007733375794487074 m projected, 9.082683283256898e-8 geographic degrees,
and 9.313225746154785e-10 m projected round trip. Both grid paths have zero
error against their independent controls. The geographic value is an oracle
comparison, not a self round trip.

Automatic terrain alignment matches the independent frame byte for byte in
RGBA and pick IDs, with 622 visible vector pixels and three stable feature IDs.
Explicit raster-sample heights differ by at most 0.0000019073486328125 m in the
GPU pick readback. East/west and north/south reversal controls retain visible
coverage but produce errors of 9.99995231628418 m and 15.266280174255371 m,
respectively, and different rendered images.
The absolute-coordinate negative control has zero visible vector pixels.
Three aligned labels have maximum horizontal error 9.313225746154785e-10 m.
Failed and superseded ingestion retain the committed reference image. The
installed consumer reports 14197342 live asset bytes, a 16777216-byte WASM heap,
zero GPU allocations, and zero workers, assets, heap or reservations after
settled disposal. Reports are `test-results/w14-package-consumer.json` and
`test-results/w14-remote-datasets.json`.

The initial aggregate `test:package` had three Windows `EPERM` failures creating
symlink fixtures. The fixtures now use real directory junctions on Windows and
file/directory symlinks on Unix, preserving the linked-source and distribution
integrity assertions without requiring host privilege changes. The aggregate
package check passes: nine documentation checks, 118 browser-harness tests,
609 infrastructure tests with one existing Unix-UID-only skip on Windows,
and the emitted package contract. Git's Bash is selected in the command's PATH
to avoid the unrelated WindowsApps Bash-selector failure. The W14 spec inventory
and shared WebGPU guard pass. No host security settings were changed.

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
npm run test:datasets:remote
npm run prepare-dist # restore packaging rewrites after test:datasets:remote's TypeScript build
node tests/api/package-contract.mjs
npm run test:package
npm run verify:parity
```
