# CRS and datasets

W14 implements G01 coordinate reference systems and the E06 dataset registry.
Both operate without a GPU. The projection backend is the exact unmodified
`proj-wasm@0.1.0-alpha9` Emscripten binary, database and JavaScript module,
running through PROJ's C API in a Forge3D W02 worker pool. It requires Workers,
WebAssembly and WebCrypto in a secure browser context, without SharedArrayBuffer.

```ts
import { CrsTransformer, DatasetRegistry, VectorLayers } from "@forge3d/web";

const crs = await CrsTransformer.create();
const datasets = new DatasetRegistry();
const layers = new VectorLayers();
try {
  const fuji = await crs.transformCoords(
    [[138.7274, 35.3606]],
    "EPSG:4326",
    "EPSG:32654",
  );
  // Approximately [293517.347, 3915404.017], in metres.
  const dem = await datasets.miniDem(); // Float32Array, width=height=256
  const boundaries = await datasets.sampleBoundaries(); // native GeoJSON
  await layers.addGeospatial(
    {
      name: "Fuji",
      crs: "EPSG:4326",
      features: [{ id: 1, kind: "point", position: [138.7274, 120, 35.3606] }],
    },
    "EPSG:32654",
    crs,
  );
} finally {
  layers.dispose();
  datasets.dispose();
  crs.dispose();
}
```

`parseCrs()` accepts EPSG/OGC identifiers, PROJ CRS strings, WKT1/WKT2 and
PROJJSON, validates against the pinned database and returns name, authority,
EPSG code, WKT and axis metadata. `parseCrsFromWkt()` returns a canonical EPSG
identifier, valid unrecognized WKT, or null for invalid input. `crsToEpsg()` is
the synchronous lexical identifier helper; use `parseCrs()` for WKT recognition.
`crsFromRasterMetadata()` extracts WKT, CRS or GeoTIFF GeoKeys supplied by a
browser raster loader. `crsFromGeoJson()` extracts legacy CRS declarations and
uses RFC 7946 WGS84 when none is supplied.

`transformCoords()` accepts nested tuples or flat Float32Array/Float64Array
buffers. It returns fresh nested arrays or Float64Array. Tuples may carry
two, three or four ordinates; flat arrays use `stride: 2 | 3 | 4` (default 2).
Input buffers remain owned by the caller. `alwaysXY` defaults to true
(longitude/easting first); false respects the CRS authority's axis order.
Invalid shapes, CRS definitions and nonfinite values produce `INVALID_INPUT`.
An identity transform still validates the CRS and returns a fresh copy.

`reprojectGeometry()` handles every GeoJSON geometry, GeometryCollection,
Feature and FeatureCollection, including polygon holes, nested topology, null
feature geometries, Z/T, properties and IDs. Bounds are recomputed. GeoJSON
horizontal coordinates always use XY order. `VectorLayers.addGeospatial()`
reprojects to a supplied terrain's `crs` and local frame, or an explicit absolute
CRS, before committing; a failed conversion leaves layers and IDs intact. Vector renderer coordinates
are Y-up: X/Z form the map plane and Y is preserved elevation.
`reprojectVectorLayer()` provides the same conversion without insertion.
`reprojectLabelFeatures()` bridges asynchronous PROJ to W13 label recipes.

For automatic rendering, pass a georeferenced `TerrainDataset` to
`runtime.setTerrain(dataset)`, add layers carrying their source `crs`, then
`await runtime.setVectorLayers(layers)`. This ordinary ingestion method projects
every tagged layer to the retained terrain CRS and converts the result into its
centered X/Z sample grid. A new worker is disposed after each ingestion. Await
completion before rendering; failed or superseded ingestion commits no layers.
Caller arrays retain their source coordinates. Submit edits again through this
method. Untagged local layers keep the synchronous rendering path.

The terrain requires its dimensions, spacing and GDAL six-element pixel-corner
`transform: [x0, dx, rotationX, y0, rotationY, dy]`. Sample (0,0) lies at pixel
(0.5,0.5). Inverting the affine handles north-up rasters, rotation and large
projected origins; local spacing and terrain centering match the renderer.
Missing or singular transforms fail explicitly. `reprojectLabelFeatures()` uses
the same local frame when passed a terrain dataset. An explicit CRS string
continues to return absolute CRS coordinates for non-rendering uses.

## Grids, precision and deployment

PROJ networking is always disabled. CRS operations use `ONLY_BEST=YES` and
`ALLOW_BALLPARK=NO`. Missing required grids produce `UNSUPPORTED_FEATURE` with
`details.kind: 'crs-missing-grid'`, the PROJ errno/reason and unavailable grid
names. Optional/null grids in CRS definitions are rejected. The package
bundles the public-domain NOAA `us_noaa_conus.tif` horizontal shift fixture,
versioned as `proj-data-conus-v1`. Supply additional local grids with
`grids: [{ name, url, sha256, version, byteLength }]`; names must be unique safe
filenames. Every grid is digest-checked before entering the worker filesystem.
`bundledGrids: false` disables the bundled fixture. `transformPipeline()` accepts
explicit PROJ pipelines and requires every named grid to be supplied; its input
units and steps are the pipeline's contract. The bundled conus fixture alone
does not satisfy modern NADCON5 operations; those fail until their best grids
are supplied. A system-to-system transform from
`+proj=longlat +ellps=clrk66 +nadgrids=us_noaa_conus.tif +type=crs` to
`EPSG:4326` uses the bundled grid without a hand-written pipeline. Default
EPSG NAD27-to-NAD83 operations still require the newer grids.

Serve the package's `dist/` and `assets/` directories together without modifying
the pinned PROJ bytes or emitted worker. JavaScript and worker modules use `script-src 'self'`
and `worker-src 'self'`; WASM compilation requires `'wasm-unsafe-eval'` where
the browser enforces it. There is no dependency CDN. Local files must be served
over HTTP(S). Packaging verifies the PROJ module's digest before embedding its
factory declaration in `dist/crs-worker.js`. No PROJ asset URL is imported as
executable JavaScript. The transformer fetches the original module only as
verified reference data; the worker compares the embedded factory's exact source
before calling it and receives verified WASM/database/grid bytes. A hostile second module response
has no execution path. The dev server embeds the same verified declaration after
TypeScript compilation and serves worker bytes without HMR rewriting. The host
must trust the application worker and its ordinary same-origin dependencies.
Bundlers should serve the package directories
as static assets; projection asset paths are relative to the installed module.

The W00 `crs-epsg-v1` contract is preserved byte for byte as a JSON record.
Supplemental W14 controls separately pin UTF-8/LF fixture bytes. Independent
pyproj controls cover forward and inverse Web Mercator, UTM 32N, Fuji UTM 54N
and UTM 32S. Inverse inputs are rounded projected coordinates, with independently
computed geographic expectations. Published EPSG Guidance Note 7-2 examples
also test Web Mercator and British National Grid in both directions. Acceptance
is 1e-7 geographic degrees, 0.01 m projected and 0.02 m projected round trips.
The geographic metric compares against the independent inverse oracle, rather
than self round trips. Axis-order, WKT and both grid APIs are also tested.

## Dataset registry and offline cache

`available()`, `bundled()`, `remote()`, `listDatasets()`, `datasetInfo()` and
`info(name)` expose defensive metadata for the two native bundled fixtures
and all ten remote native records. `fetch()`, `fetchDem()`, `fetchCityJson()`
and `fetchCopc()` return verified bytes; format-specific helpers check remote
registry kinds and accept bundled names, matching native behavior. Default URLs
use data-repository commit `043a032cf00bee20a2299514484f811de8a53e9f`, selecting Git LFS media for five
raster files and raw Git URLs for five ordinary blobs. Content is pinned by
SHA-256 and size. Two stale native building-file digests are retained as
`nativeSha256`; the fetch digest pins their actual committed Git bytes. Storage
provenance records the verified data-repository tree. Override `baseUrl` to self-host remote datasets and
`bundledBaseUrl` to relocate fixtures. Supply `entries` for an application
registry. Unknown names and wrong kinds produce `INVALID_INPUT`; HTTP errors
and digest mismatches produce `IO_ERROR` with structured details.

`miniDem()` decodes the exact native little-endian, C-order float32 NPY fixture
without evaluating its header. `sampleBoundaries()` parses the exact native
GeoJSON. `miniDemUrl()` and `sampleBoundariesUrl()` replace native filesystem
path helpers with package-relative URLs. TIFF, CityJSON and point-cloud
decoding remain owned by their respective feature tasks.

The native boundary polygons use normalized terrain coordinates. Their registry
metadata declares `coordinateSpace: 'normalized'` and carries no geographic CRS;
use the explicit source CRS of application data when requesting reprojection.
The grid fixture includes independent pyproj controls at three US locations.

Both APIs probe W02's OPFS, IndexedDB and CacheStorage adapters by default.
Pass a `PersistentByteCache` to select storage, or `cache: null` to disable it.
Keys include the content digest and asset version. Every hit is checked against
the expected registry digest as well as the cache frame checksum. Corruption
deletes the entry; an online read refetches, while offline reads fail explicitly.
`offline: true` permits cache reads only. Projection binaries, database, grids
and datasets persist across transformer/registry instances and disposal.

Offline code loading also requires the application/module graph to be cached
by the host (HTTP caching or a service worker). The installed-package test warms
immutable self-hosted modules, disables all browser networking, and creates a
fresh worker from the persistent binary/grid cache. It also reads both datasets
offline. Asset-cache success never substitutes identity for a missing grid.

## Resource lifetime and verification

Projection defaults to a 256 MiB admission budget, 32 MiB per asset and one
million points per batch. Admission accounts conservatively for assets, the
WASM heap and queued coordinate reservations before allocating a batch.
`getDiagnostics()` exposes these quantities, worker/pending counts, grid names
and zero GPU bytes. Dataset reads default to 256 MiB per asset and a bounded
64 MiB memory cache, with cache bytes and active requests in diagnostics.
`signal` cancels setup, fetches and projection calls; progress callbacks report
byte reads. Synchronous native work already running can finish internally after
caller cancellation, with every PJ/context/coordinate allocation freed in
finally blocks. Disposal is synchronous and idempotent, terminates the owned
worker and rejects pending work. It releases memory but preserves shared
persistent cache entries. GPU device loss has no effect on these CPU services.

Run `npm run test:w14`, `npm run test:api`, `npm run test:package-consumer:w14`
and `npm run verify:parity`. `npm run test:datasets:remote` downloads all ten
remote datasets through their real default URLs and verifies full bytes; CI
runs this live integration gate separately from the offline package test. Asset preparation and fixture regeneration are
explicit maintainer operations (`prepare-w14-assets.mjs` and
`scripts/generate-w14-fixtures.py`); normal builds verify pinned checked-in bytes.
The package consumer runs without Python, bare runtime imports or a repository
checkout and writes measured evidence under `test-results/`.
