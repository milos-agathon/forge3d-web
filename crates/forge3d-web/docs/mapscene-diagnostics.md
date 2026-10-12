# MapScene and structured diagnostics

`MapScene` owns a typed recipe, validates its resources, prepares completed layer
adapters, and returns a PNG `Blob`, RGBA `Frame`, validation report and review hashes.
Use the package entrypoint. The [browser example](../examples/mapscene.html) renders
terrain, imagery, vector roads, scalar buildings, mesh/scatter geometry,
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
| `point-cloud` | All MapScene recipes block with `placeholder_fallback`, including nonempty points and LAS/LAZ/COPC/EPT. W16 standalone APIs remain separate. |
| `tiles3d` | All MapScene recipes block with `python_public_3dtiles_incomplete`; local metadata is summarized without loading content. W16 standalone APIs remain separate. |
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
W09 scatter uses its accepted adapter. M02b keeps point-cloud and tiles diagnostics
until G02-G04/W16 acceptance is complete, including independent laz-perf security
sign-off. Rendering some points does not satisfy that gate. This is not full Cesium runtime parity.
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
combined transient GPU budget is 512 MiB. The 128-layer, 16-megapixel and 64 MiB
guards are browser defaults, not native parity limits. `diagnosticsPolicy.maxLayers`,
`maxOutputPixels` and `maxResourceBytes` override them; each `source.maxBytes` overrides
its resource cap. The aggregate serialization cap defaults to the largest of
64 MiB and the explicit resource caps. `diagnosticsPolicy.maxRecipeBytes` can set
that cap separately. Construction, validation, serialization and JSON replay use
the same cap. The 512 MiB policy comes from R07; W02 owns actual GPU allocation
tracking. Raising browser guards does not raise device texture limits.
Decoders and GPU owners enforce limits;
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

## Diagnostic reference

`MapScene.validate` checks camera keys, label/point style and traversal keys,
lighting presets, and the merged raster overlay options (at most eight visible
layers, including inherited terrain overlays). Unknown JSON fields are errors.
Remote assets are unresolved during synchronous validation; `prepare()` diagnoses
fetch/decode failures before any GPU render. The public API returns source-derived
PNG pixels from actual WebGPU/WASM rendering and exposes the backend in
`reviewRecord().last_render.backend`. `MapScene.render` returns a Blob; output
dimensions replace a filesystem path. `MapScene.save_bundle` belongs to M04/W19.

| Code | Meaning / correction |
|---|---|
| `missing_crs` | Supply explicit scene and source CRS. |
| `missing_source_identity` | Supply a nonempty source ID and URL if used. |
| `missing_renderable_data` | Supply exactly one inline source or URL. |
| `missing_external_asset` | Fetch the declared asset successfully. |
| `unsupported_asset_format` | Use a format supported by the layer adapter. |
| `unsupported_output_format` | Use PNG; this diagnostic is fatal. |
| `unsupported_layer_type` | Use a declared layer type. |
| `unsupported_feature` | Retain the error until the owning task accepts the requested product path. |
| `unsupported_recipe_field` | Correct unknown camera, style, traversal, overlay or recipe keys. |
| `invalid_layer` | Correct malformed geometry or layer settings, including raster options/count. |
| `invalid_lighting` | Use default/daylight/overcast/sunset or valid explicit lights. |
| `invalid_camera` | Supply valid camera geometry and projection values. |
| `invalid_scene_settings` | Correct materials, environment, shadows or post-processing settings. |
| `invalid_memory_budget` | Supply a positive safe integer GPU budget. |
| `invalid_resource_limit` | Supply positive safe integer browser guard limits. |
| `invalid_output_size` | Supply positive integer dimensions; this diagnostic is fatal. |
| `invalid_seed` | Supply an unsigned 32-bit seed. |
| `unsupported_backend` | Use WebGPU, or explicit CPU tracing. |
| `resource_limit_exceeded` | Reduce input/output size or raise the relevant browser guard. |
| `unsupported_layer_combination` | Separate dedicated tracing output from raster settings/layers. |
| `duplicate_layer_id` | Assign unique layer IDs. |
| `duplicate_resource_id` | Use consistent bytes/options for shared IDs; scene: is reserved. |
| `invalid_asset_hash` | Supply a 64-character hexadecimal SHA-256. |
| `experimental_render_path` | Explicit unverified render intent blocks output. |
| `asset_integrity_mismatch` | Source bytes do not match the declared hash. |
| `resource_load_failed` | Correct corrupt or undecodable resource bytes. |
| `layer_prepare_failed` | Correct layer data/settings rejected by its preparation adapter. |
| `preparation_failed` | Preparation threw before it could return a report. |
| `render_cancelled` | Preparation, rendering or output was cancelled. |
| `render_failed` | Rendering or the output sink failed after successful validation. |

Native factory codes retain messages, remediation, IDs, details and severity:
`crs_mismatch`, `missing_glyphs`, `unsupported_style_field`,
`unsupported_style_layer_type`, `pro_gated_path`, `placeholder_fallback`,
`experimental_feature`, `vt_unsupported_family`, `python_public_3dtiles_incomplete`,
`estimated_gpu_memory`, `label_rejection_summary`, `missing_label_field`,
`unicode_coverage_gap`, `unsupported_tile_format`, `unsupported_tile_feature`,
`missing_texture_path`, `missing_uvs`, `unsupported_texture_format`,
`unavailable_cache_lod_stats`, `unsupported_instancing_path`,
`unavailable_terrain_sampler` and `missing_external_asset`.

## Support and ownership

| Capability | Support level | Scope / owner |
|---|---|---|
| MapScene.render PNG path | `supported` | Covered geometry, shaped glyphs, deterministic LabelPlan and review JSON; M02a/W18. |
| Style assessment | `supported` | Local fill/line/circle diagnostic assessment; style render mapping M03/W19. |
| MapSceneBuildingLayer | `supported` | Scalar buildings; missing_external_asset and unsupported_asset_format remain errors; W15/M02a. |
| Point-cloud MapScene path | `placeholder/fallback` | M02b retained gate; G02-G04/W16 acceptance pending. |
| Tiles3D MapScene path | `underdeveloped` | python_public_3dtiles_incomplete retained by M02b. |
| VT families | `supported` | albedo-only; vt_unsupported_family blocks normal/mask; W08. |
| Requested unavailable cache/LOD stats | `underdeveloped` | unavailable_cache_lod_stats; M02b. |
| Product instancing | `unsupported` | unsupported_instancing_path; M02b. |
| Pro import intent | `Pro-gated` | pro_gated_path; keep blocked. |

Canonical examples and support guides: [MapScene](../examples/mapscene.html),
[recipe helpers](../examples/w18-mapscene.js), [LabelPlan](labels.md),
[vector/style scope](vector-layers.md), [building scope](geometry-mesh-io.md),
[tiles scope](pointcloud-tiles.md), [VT and product boundaries](support-matrix.md).
Run `npm run test:w18` for their executable regression tests.

W18 does not claim Streamed browser map delivery as a global map product,
Complete Mapbox style parity, Cesium-grade global runtime parity, or General DCC
or game-editor workflows. Textured PBR buildings and VT normal/mask runtime remain
blocked as documented above. W08/W14 streaming primitives have their own scope;
they do not close these product boundaries. Bundle operations are W19, furniture
and exports W20, and the full example catalog W23.
