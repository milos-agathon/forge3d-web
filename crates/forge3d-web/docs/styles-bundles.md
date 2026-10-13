# Styles, portable bundles and scene review

W19 implements T18, M03 and M04. The browser API uses local/provided vector
features and versioned ZIP Blobs. It preserves the native diagnostic boundary:
automatic Mapbox symbol layers remain `experimental_feature` / `underdeveloped`.
`styleLabelRecords` and `styleToLabelStyle` convert their text and styling for an
explicit W13 label layer. Streamed MVT and the full Mapbox specification remain
diagnosed, as in the native contract.

```ts
import { MapScene, parseStyle, compileStyle, SceneState } from '@forge3d/web';

const style = parseStyle({ version: 8, layers: [
  { id: 'roads', type: 'line', source: 'local', paint: {
    'line-color': '#ffaa00', 'line-width': 3,
  } },
] });
const compiled = compileStyle(style, { local: [
  { id: 1, kind: 'line', positions: [[-5, 0.2, 0], [5, 0.2, 0]] },
] }, { crs: 'LOCAL' });
const scene = MapScene.fromSceneState(new SceneState({
  base: {
    crs: 'LOCAL', camera: { kind: 'orbit-camera', target: [0, 0, 0], distance: 20 },
    output: { width: 256, height: 192 }, layers: compiled.layers,
  },
  style: style.value,
  reviewLayers: [{ id: 'notes', layers: [{ kind: 'nodes', layerId: 'note-panel',
    nodes: [{ kind: 'overlay', name: 'note', bounds: [10, 10, 40, 20], color: [1, 0, 0, 1] }],
  }] }],
  variants: [{ id: 'map', activeLayerIds: [] }, { id: 'review', activeLayerIds: ['notes'] }],
  activeVariantId: 'map',
}));
await scene.render();
await scene.applyVariant('review');
await scene.setReviewLayerVisible('notes', false);
const blob = await scene.saveBundle({ name: 'Road review' });
const restored = await MapScene.loadBundle(blob);
await restored.render();
scene.dispose(); restored.dispose();
```

`loadStyle` accepts URL, File, Blob, typed bytes, ReadableStream or a file handle.
`loadStyleLayers` loads bounded GeoJSON sources; `styleFeaturesFromGeoJson`
converts Point, LineString, Polygon and their Multi variants. GeoJSON coordinates
`[x,z,elevation]` become engine coordinates `[x,elevation,z]`; use W14 CRS
transforms when coordinates require reprojection. `compileStyle` assigns each feature to its first matching geometry-compatible
fill, line or circle layer, as the native overlay converter does. Fill outline
color is available to the paint helper; the native converter does not draw an
extra outline. Default lines are black. It assigns unique pick IDs and
retains the original identity in feature properties. Native `maxzoom` is
inclusive. Converter paint evaluation uses the native default context: empty
properties and zoom 10; the supplied zoom selects visible layers. For explicit
data-driven paint evaluation, call `styleToVectorStyle(layer, {properties, zoom})`.
Legacy filters preserve native pass-through for unknown operators and diagnose
the unsupported intent. Text offsets are em values multiplied by text size.
Expressions cover native property, control, interpolation, arithmetic,
comparison, logic, string, conversion and color families, including Python
boolean/numeric coercion and computed float formatting. JavaScript cannot
distinguish literal `3` from literal `3.0`; integral literals follow integer
formatting, while computed native float results retain their kind. Like the native numeric
evaluator, HCL/LAB aliases use numeric interpolation; the parser explicitly
diagnoses unavailable perceptual color interpolation. Invalid/unknown fields and
operators never disappear from the support report. `MapScene.fromStyle` retains
that report in validation and rendering policy.

`SpriteAtlas` validates bounds, extracts RGBA/UVs and retains DPI/SDF metadata.
`loadSpriteAtlas` loads `.json` and `.png`, with explicit `pixelRatio: 2` for
`@2x`. `loadGlyphRanges` deduplicates Unicode blocks, substitutes escaped
fontstack/range tokens and checks glyph PBF v1 metrics, signed bearings, bitmap
sizes and requested ranges. Sprite bitmaps and glyph ranges are owned by their
caller; dispose an atlas when finished. Glyph data is available for inspection
and adapters; it does not promote the diagnostic symbol rendering path.

Bundles contain `manifest.json`, `scene/state.json` and deduplicated asset
payloads. SHA-256 covers every payload, including canonical state, typed-array
bits, bookmarks, label plans, diagnostics and variants. Verification is mandatory;
there is no unchecked-load option. It detects tamper, missing/extra checksums,
duplicate entries, unsafe names, malformed headers, truncation and unsupported
compression/schema versions. Defaults are 128 MiB compressed, 256 MiB expanded
and 4096 entries; callers can lower these limits. ZIP64/encryption are unavailable
and return a typed error. Assets use content-addressed paths and owned Blob URL
leases. Plain glTF subordinate buffers/images are embedded before packaging;
resource hashes are recomputed for the rewritten payload. Label bundles include
the verified font bytes, so preparing a restored label
layer never requires another font fetch. LabelPlan payloads and these fonts are
part of the checksummed canonical state.
No runtime dependency CDN is required: `fflate@0.8.3` and its MIT notice ship under `dist/vendor`.

`saveBundle` accepts a `SceneState` and can write to a Blob, backpressured stream,
file handle, download or OPFS sink. `loadBundle` accepts URL/File/Blob/stream/
bytes/file handles, including OPFS handles. Download and file-picker names
append `.forge3d` when no suffix was supplied; existing suffixes and explicit
OPFS paths are preserved. `LoadedBundle` exposes defensive
manifest/state snapshots, named variants, visibility, verified bytes and asset
resolution. A style sprite base acquires its `.json`/`.png` pair. Glyph ranges
come from inline symbol text, `styleGlyphRequests: [{fontStack, text}]`, or an
explicit inventory in `assets` keyed by resolved original URLs. Supply `@2x`
assets explicitly when needed. A glyph template alone stays as metadata when no text requests a range, so
fill/line styles round-trip without font fetches. Requested ranges must be
archived or carry blocking missing-asset diagnostics. Pass `resolveUrl: url => bundle.resolveAsset(url)` to the loaders,
or `url => scene.resolveBundleAsset(url)` for an adopted MapScene. Both save
paths retain supplemental assets and logical aliases. Streamed MVT/raster source
URLs and tile templates remain unsupported intent with warnings; they are never
fetched or promoted into executable content during packaging. `LoadedBundle.dispose` revokes every lease and releases
archive/state buffers. `MapScene.loadBundle` adopts this ownership and releases it
when the scene is disposed. Worker-compatible array/Blob APIs avoid DOM use.

MapScene saving preserves missing resources as explicit blocking diagnostics by
default. It marks their review record `blocked_by_diagnostics`, with no successful
render claim; included assets still verify. Use `allowMissingAssets: false` for a
strict export. Standalone `saveBundle` defaults to strict asset acquisition.
MapScene snapshots use a fixed default archive timestamp for deterministic output;
`createdAt` can override it. Cancellation and disposal abort pending acquisition
and stream/file writes. Staged filesystem cancellation preserves the previously
committed file. Storage quota failures return `RESOURCE_LIMIT_EXCEEDED` with
`reason: quota-exceeded`; `onProgress` reports asset, archive and verification
work with bounded completed/total counters. Variant changes prepare a candidate before replacing any
active resources. Failure, cancellation or disposal leaves no partial commit;
applying a variant clears manual visibility overrides and replaces its preset.

Migration accepts checksum-verified browser v1 recipe archives and zipped native
v1/v2 directories. Native legacy mirrors synthesize a review registry; native v2
variants retain their IDs and ordering. The native `base_state` key is read
directly; preset/bookmark mirrors override it when present. Variant presets
replace base preset fields even when empty. Terrain colormaps and native label
anchors are preserved in their typed adapters. Native raster extents map
directly to the UV `extent` field. Native vector depth bias below W12's 0.01
minimum is raised to 0.01; supported values remain unchanged and the original
value stays in `nativeSceneState`. Migrated feature IDs are unique across base
and review overlays, so activating a review vector cannot collide with the base. `nativeRecipe` can supply camera/output
context. Native vector payloads, labels, raster overlays and GeoTIFF terrain map
to browser layers. Original native state/manifest are retained as
`nativeSceneState`; fields needing a browser adapter return blocking
`unsupported_bundle_field` diagnostics instead of claiming equivalent rendering.
Native filesystem paths, scatter configuration and opaque preset fields retain
their data even when the browser adapter cannot execute them.

Run the example at `examples/style-bundle.html`. The checks are `npm run test:w19`
and `npm run test:package-consumer:w19`. Native expression/color/mapping and real-saver references are
executed independently from hash-pinned `bf8db93` sources by
`scripts/generate-w19-native-fixtures.py`; web output is not the oracle. Browser
tests assert covered geometry and measure removal of each styled layer, exact
offline pixels, atomic changes, OPFS/streams, asset leases and repeated disposal.

Protocol references: [Mapbox sprites](https://docs.mapbox.com/style-spec/reference/sprite/),
[glyph PBF v1](https://github.com/mapbox/glyph-pbf-composite/blob/master/proto/glyphs.proto)
and [fflate](https://github.com/101arrowz/fflate).
