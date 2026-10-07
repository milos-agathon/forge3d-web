# Point clouds and OGC 3D Tiles

W16 provides browser datasets, bounded caches, octree/SSE selection, GPU point
rendering and OGC tile content. All decoder assets are self-hosted in the npm
package. See [W16 evidence](w16-evidence.md) for fixtures, limits and verification.

W16 acceptance remains pending: physical reference-profile qualification and
the dependency lock's mandatory laz-perf security review are open. Current
codec consumption is experimental conformance testing.

## Load and render points

```ts
import {openCopc, PointCloudLayer, PointCloudRenderer} from '@forge3d/web';

const dataset = await openCopc('/data/survey.copc.laz', {
  cacheBytes: 64 * 1024 * 1024,
  maxBytes: 256 * 1024 * 1024,
  signal: abortController.signal,
});
const layer = new PointCloudLayer(dataset, {
  ownsDataset: true,
  pointBudget: 1_000_000,
  style: {pointSize: 2, colorMode: 'rgb'},
  adaptiveBudget: {targetFrameMs: 16.7, minPoints: 100_000},
});
const renderer = await PointCloudRenderer.create(canvas);
const view = {
  position: [x, y, z] as const,
  viewportHeight: canvas.height,
  fovY: Math.PI / 4,
  viewProjection, // 16 column-major numbers; WebGPU depth 0..1
};
const start = performance.now();
await layer.update(view);
renderer.setLayers([layer]);
await renderer.render(view);
layer.recordFrameTime(performance.now() - start);
const point = await renderer.pick(pixelX, pixelY);
console.log(point, layer.stats(), renderer.getStats());
// On teardown, dispose the renderer before its retained layer.
renderer.dispose();
layer.dispose();
```

`openEpt(url)` resolves hierarchy/data files relative to `ept.json` and supports
binary and LASzip records. `openLaz` supports LAS/LAZ URLs, files, blobs and byte
sources. `openPointCloud` detects conventional names; pass `format` for blobs
or extensionless resources. COPC reads headers, VLRs, hierarchy pages and chunks
through W08 `RangeScheduler`; servers must return matching 206 Content-Range.
A 200 response to Range is rejected without consuming the full response body.

COPC/EPT samples are additive across levels, so layers default to `mode: 'add'`.
The standalone traverser defaults to native leaf selection (`replace`). Budgets
are strict, including cameras inside nodes. ADD selection stops below an
ancestor rejected by budget, so every detail sample retains its coarse base.
A budget smaller than the root count selects nothing. REPLACE selection can
refine an oversized ancestor into children that fit. A stable heap prioritizes projected bounds.
`maxDepth`, `minSpacing`, `sseThreshold` and the optional homogeneous frustum
control selection. Adaptive budgeting uses a p95 sample window and hysteresis;
call `recordFrameTime` with the complete frame duration.

Positions retain Float64 source coordinates and are converted relative to the
layer origin for GPU precision. Projection remains explicit through W14
`reprojectPointData`. A native six-float GPU interleave and historical twelve-
float viewer interleave are available from `PointBuffer`; the renderer uses a
32-byte instanced billboard per point with depth-aligned integer picking.
Styles support RGB, elevation (source Z), intensity, classification, color tint,
opacity, circle/square shape and point size. Source batch IDs remain attributes;
the picking ID namespaces each layer/node/point and returns its original index.

## Workers, caching and recovery

Pass an existing W02 `Forge3DWorkerPool` with `createPointCloudWorkerHandler` to
datasets to decode in real workers. The handler supports whole LAZ, COPC chunks
and EPT binary. The same handler works through W02's main-thread fallback.
`transferPointData` copies into owned transferable arrays so caller buffers are
not detached. See [the worker example](https://github.com/milos-agathon/forge3d/blob/main/crates/forge3d-web/examples/w16-worker.js).

Dataset `cacheBytes` is split between compressed bytes and decoded LRU entries.
An oversized cache item fails before eviction; caches have byte/hit/eviction
stats. Pass a W08 digest-checked `persistentCache` for offline reads. `maxNodes`,
`maxPoints` and `maxBytes` bound untrusted metadata and decoded allocations.
Dataset disposal aborts outstanding IO; caller-supplied pools/caches remain
caller-owned. Individual cancellation does not discard a committed layer view.

GPU admission includes live targets, vertices, uniforms, staged replacements
and readbacks. `setLayers` rejects pressure before changing the visible set.
`resize`, `pick`, `readRgba` and disposal account for their allocations. After
device loss, `recover` creates a new device and rebuilds retained CPU layers
without network reads. Retain the layer until recovery or renderer disposal.

## OGC tiles

```ts
import {loadTileset, Tiles3dLayer} from '@forge3d/web';
const tileset = await loadTileset('/tiles/tileset.json');
const tiles = new Tiles3dLayer(tileset, {ownsTileset: true, sseThreshold: 16});
await tiles.update(view);
const points = tiles.asPointCloudLayer(); // snapshot with its own lifetime
await points.update(view);
tiles.addMeshesToScene(scene); // W15 batches and scalar PBR materials
tiles.dispose();
```

Tileset 1.0/1.1 parsing supports inherited ADD/REPLACE, affine transforms,
sphere/oriented-box/geographic-region bounds, frustum culling, relative content
URIs, extensionless external trees and cycle/depth limits. External trees are
recognized from content bytes rather than their URL suffix. SSE defaults to the native center
distance; opt into `surfaceDistance`. Geographic regions use WGS84 ECEF and
ignore tile transforms as required by OGC. Sphere scaling conservatively handles
affine shear; geographic radii conservatively cover bounds around the SSE center.
Replacement content commits once the complete selected view loads.

PNTS supports float or quantized positions, RTC, RGB/RGBA/RGB565/constant colors,
float/octahedral normals and batch IDs/tables. B3DM unwraps tables and delegates
all GLB parsing to W15 `decodeGltf`. Mesh instances apply glTF scene/TRS, Y-up to
tile Z-up, RTC and world transforms, then the layer origin. Texture-dependent
scene insertion returns `tile-texture-bindings-required` until explicit W15
TextureSet bindings are supplied. Required extensions, implicit tiling,
multiple contents, Draco PNTS, i3dm/cmpt and EPT zstandard return structured
`UNSUPPORTED_FEATURE` diagnostics. They are outside G02-G04's native baseline.

## Verification

```powershell
npm run test:w16
npm run test:package-consumer:w16
$env:FORGE3D_W16_SOAK='1'
npm run test:package-consumer:w16
```

The installed consumer checks public TypeScript, compressed real data, a
million-point/eight-level EPT workload, 64 native camera records, real module
workers, CSP, ranged reads, GPU colors/picking, loss, allocation cycles and
disposal. The explicit soak uses a static server to prevent edit-triggered
reloads, 1920x1080 output and complete traversal/upload/render frame time. A
local Chromium run records its adapter; W00 reference profile qualification
requires the exact pinned hardware/driver/OS from the hardware matrix.
