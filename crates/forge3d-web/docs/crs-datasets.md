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
reprojects to a supplied terrain's `crs` or an explicit CRS before committing;
a failed conversion leaves layers and IDs intact. Vector renderer coordinates
are Y-up: X/Z form the map plane and Y is preserved elevation.
`reprojectVectorLayer()` provides the same conversion without insertion.
`reprojectLabelFeatures()` bridges asynchronous PROJ to W13 label recipes.

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
are supplied.

Serve the package's `dist/` and `assets/` directories together without modifying
the pinned PROJ module. JavaScript and worker modules use `script-src 'self'`
and `worker-src 'self'`; WASM compilation requires `'wasm-unsafe-eval'` where
the browser enforces it. There is no dependency CDN. Local files must be served
over HTTP(S). The repository Vite middleware serves the pinned module unchanged
so HMR cannot invalidate its hash. Bundlers should serve the package directories
as static assets; projection asset paths are relative to the installed module.

The independent `crs-epsg-v1` pyproj controls cover 32 WGS84 points in Web
Mercator and UTM 32N, Fuji in UTM 54N, and UTM 32S. Acceptance is 1e-7 degrees,
0.01 m projected and 0.02 m projected round trips. Axis-order, WKT and actual
nonidentity grid cases are also tested.

## Dataset registry and offline cache

`available()`, `bundled()`, `remote()`, `listDatasets()`, `datasetInfo()` and
`info(name)` expose defensive metadata for the two native bundled fixtures
and all ten remote native records. `fetch()`, `fetchDem()`, `fetchCityJson()`
and `fetchCopc()` return verified bytes; format-specific helpers check registry
kinds. The remote LFS media base is pinned to native commit `1f4084a`, retaining
all native SHA-256 values. Override `baseUrl` to self-host remote datasets and
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
and `npm run verify:parity`. Asset preparation and fixture regeneration are
explicit maintainer operations (`prepare-w14-assets.mjs` and
`scripts/generate-w14-fixtures.py`); normal builds verify pinned checked-in bytes.
The package consumer runs without Python, bare runtime imports or a repository
checkout and writes measured evidence under `test-results/`.
