# MapScene and structured diagnostics

`MapScene` owns a typed recipe, validates its resources, prepares completed layer
adapters, and returns a PNG `Blob`, RGBA `Frame`, validation report and review hashes.
Use the package entrypoint. The [browser example](../examples/mapscene.html) renders
terrain, imagery, vector roads, scalar buildings, mesh/scatter geometry, points,
real shaped glyphs and an annotation. Run `npm run dev` to open that example.

## Quickstart

```ts
import {
  MapScene, SceneRecipe, TerrainSource, OrbitCamera, LightingPreset,
  OutputSpec, ReproducibilityProfile, RenderFailurePolicy,
} from '@forge3d/web';

const recipe = new SceneRecipe({
  crs: 'LOCAL',
  terrain: new TerrainSource({source: {
    id: 'dem-v1', format: 'heightmap', crs: 'LOCAL',
    data: {width: 3, height: 3, spacing: [10, 10], domain: [0, 3],
      heights: new Float32Array([0, 1, 0, 1, 3, 1, 0, 1, 0])},
  }}),
  camera: new OrbitCamera({target: [0, 1, 0], distance: 40,
    azimuthDegrees: 30, elevationDegrees: 55}),
  lighting: new LightingPreset({name: 'daylight'}),
  output: new OutputSpec({width: 256, height: 192}),
  reproducibility: new ReproducibilityProfile({seed: 7}),
  renderPolicy: RenderFailurePolicy.CONTINUE_ON_WARNING,
});
const scene = new MapScene(recipe);
try {
  const preflight = scene.validate(); // synchronous; no GPU or network
  console.log(preflight.toJSON(), scene.resources);
  const prepared = await scene.prepare(); // optional; render also prepares
  if (prepared.renderBlocked(recipe.value.renderPolicy))
    throw Error('Recipe has blocking diagnostics');
  const result = await scene.render({signal: new AbortController().signal});
  const url = URL.createObjectURL(result.blob);
  // Display/download the PNG, then revoke the URL when finished.
  console.log(url, result.executedLayerIds, await scene.reviewRecord());
} finally {
  scene.dispose();
}
```

## Layer and resource contracts

Each layer has a unique `layerId`. Each source has `id`, `format`, explicit `crs`
and exactly one of `data` or `url`. A resource identity covers all buffers in that
asset. Validation lists every declared source and global material/IBL/probe asset;
shared IDs require identical payloads. `scene:` IDs are reserved. Unresolved URL
assets remain marked `unresolved` until asynchronous preparation verifies them.
The full example's [recipe helpers](../examples/w18-mapscene.js) show concrete inputs.

| Layer | Adapter and formats |
|---|---|
| `terrain` recipe field | W03/W07/W08 `TerrainHeightmapInput`, including streaming, albedo VT and overlays; inline heightmap, encoded JSON, little-endian `f32` plus dimensions, or GeoTIFF |
| `raster` | W08 RGBA overlays on terrain; inline RGBA or PNG/JPEG/WebP URL |
| `vector` | W12 `VectorLayerInput`; inline or encoded JSON |
| `labels` | W13 `LabelRecord[]`, `LabelPlan`, priority rules, keepouts, typography and shaped glyphs; inline or JSON |
| `buildings` | W15 building meshes, GeoJSON or CityJSON; texture intent preserves blocking W15 diagnostics |
| `mesh` | W15 `MeshInput` or OBJ/STL/plain glTF/GLB; row-major transforms |
| `point-cloud` | W16 inline points or ranged LAS/LAZ/COPC/EPT datasets |
| `tiles3d` | W16 tileset JSON, selected PNTS points and B3DM meshes; inline tilesets require `baseUrl` |
| `nodes`, `scatter` | W02 ground planes, real triangle text meshes, overlays/groups and W09 batches; terrain uses `TerrainSource`, custom node/pass intent blocks |
| `trace` | W17 mesh/SDF, materials, lights and media; dedicated output, with explicitly selected WebGPU or CPU backend |
| `diagnostic` | Unavailable product intent; always blocked before rendering |

Recipe settings also accept `environment`, `postFx`, `shadows`, `cascadedShadows`,
`lightingProbes`, `materials`, an `ibl` snapshot and fixed `timeSeconds`. Trace layers
use their own lighting/materials and cannot be combined with raster layers/settings.
Tracing uses a perspective camera and dedicated tracing settings. Camera FOV uses
degrees; the point adapter converts to W16 radians. Terrain dense
geometry uses `spacing`; `bounds` supplies georeferencing and clipmap extent.
Use matching scene/source CRS; there is no implicit reprojection. W14 projection
APIs can transform assets before constructing the recipe. Labels default to screen
coordinates; `coordinateSpace: 'world'` projects through the recipe camera.

## Diagnostics and failure policy

`Diagnostic`, `LayerSummary`, `SupportMatrixEntry` and `ValidationReport` preserve
native snake-case serialized fields, stable sorting, IDs, details and remediation.
All 22 native factories, the required/P1/P2 inventories, `validateLabelSupport`,
`validateStyleSupport` and `getMapSceneSupportMatrix` are public. Style support
assessment preserves native diagnostic truth; the style loader/evaluator/render
mapping remains W19. Reports cannot be downgraded through serialized status.

Errors/fatals block both policies. `continue_on_warning` retains warning reports;
`fail_on_warning` blocks them. The native `experimental_feature` factory remains a
warning, while explicit experimental recipe intent also receives a blocking
`experimental_render_path`. Pro, fallback, unknown fields, missing geometry and
unavailable requested product paths cannot produce a successful output record.
All-background raster output and traces without visible hits fail after rendering.
Supported W09 instancing and W16 points/tiles are promoted only by exercised adapters.
`instancingPath`, `requestedStats`, native metadata intents and optional
`diagnosticsPolicy.largeSceneSummary` retain unavailable product telemetry diagnostics.

Preparation compiles deterministic label plans. Review records retain accepted and
rejected candidates, priorities, keepouts, seeds and rejection counts. Preparation
may produce warnings for rejected labels while remaining accepted glyphs render.
The [verification record](w18-evidence.md) explains native-to-browser substitutions.

## Ownership, limits and reproducibility

Recipes copy their inputs. `toJSON()`/`SceneRecipe.serialize()` use schema
`forge3d.mapscene.recipe.v1`, sorted keys and lossless base64 typed-array bytes;
`MapScene.fromJSON()` restores them. Callbacks, cycles, unsupported prototypes,
non-finite JSON numbers and forged array tags are rejected. Typed-array bits,
including DEM nodata, survive round trips. Default serialization/per-resource
limit is 64 MiB, default layer limit is 128, output limit is 16 megapixels, and
combined transient GPU budget is 512 MiB. Decoders and GPU owners enforce limits;
memory estimates are review warnings and do not authorize allocation beyond budget.

`source.sha256` verifies fetched bytes, or canonical encoded inline data, before
use. Whole-file SHA-256 is rejected for ranged point datasets; W16 range/chunk
integrity applies there. `assetHashesOrIds` and `pixelTolerance` are review metadata.
They do not replace verified source hashes or promise cross-adapter pixel identity.
Seed and asset bytes reproduce exact output in the tested local adapter/backend.

`render({signal, onProgress, sink})` supports cancellation and a PNG byte
`WritableStream`. A success record is created only after encoding and sink completion.
Failure, cancellation and device loss clear the latest output record and release
CPU/GPU owners. A later render prepares and creates fresh owners. Concurrent
operations on one scene reject. `dispose()` aborts pending work and is idempotent.
GPU allocations are released after each render; the memory report lists retained
prepared CPU buffers/font bytes, transient GPU bytes and their measured peak.
JS object overhead and caller-owned result frames/Blobs are outside those counters.

`reviewRecord()` returns deterministic recipe/report SHA-256, resource states,
label plans and actual executed layer IDs/backend. `.forge3d` ZIP/save/load adapters
are M04/W19; cartographic furniture and SVG/PDF composition are W20. Requests for
those unavailable render paths diagnose rather than substitute an image.
