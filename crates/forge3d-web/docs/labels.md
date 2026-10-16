# Labels, typography and deterministic placement (W13)

`FontAtlas`, `LabelLayer` (`LabelManager`), `LabelStyle`, `LabelFlags`,
`TypographySettings`, `LabelFeatureSource`, `LabelPlan`, `KeepoutRegion`,
`PriorityClass`, `LabelCollisionIndex` and `declutterLabels` are public exports.
The [case contract](label-case-contract.json) governs each curved, repeated and
terrain-elevated case. A successful operation returns a stable numeric ID;
unsupported creation returns `{ok:false,id:null,diagnostics}` before allocation.

## A runnable browser workflow

Run `npm run dev` in this package and open
`/examples/test-w13-labels.html`. The fixture exposes its workflows as
`window.__w13.render()`, `outline()`, `depth()`, `session()`, `viewer()`,
`viewerReview()`, `viewerBudget()`, `lineReview()` and `contracts()`. `npm run test:w13` runs their assertions, and
`npm run test:package-consumer:w13` runs them from an isolated installed tarball
with a strict CSP. Both commands exercise real WebGPU glyph triangles and fail
on blank output. The outline comparison includes holes and a blank negative
control. Capture output agrees within one byte/channel.

```ts
import { FontAtlas, LabelLayer, Forge3DViewer } from "@forge3d/web";

const atlas = await FontAtlas.create();
const labels = new LabelLayer(atlas);
const created = labels.addLabel("Summit", [120, 300, 80], {
  fontSize: 24, color: [1, 1, 1, 1], haloWidth: 1.5, depthTest: true,
});
if (!created.ok) console.log(created.diagnostics);

const viewer = await Forge3DViewer.create(canvas);
viewer.setLabels(labels, {zoom: 4});
labels.addCallout("Peak", [100, 250, 50]);
labels.setTypography({tracking: 0.25, kerning: true, wordSpacing: 1.2});
labels.setDeclutterAlgorithm("annealing", {seed: 123, maxIterations: 50});
const report = viewer.getLabelReport();
// Camera, resize, edits and device recovery rebuild/replay the label geometry.
// Pick uses pixels in the current runtime viewport, after placement.
const pickedId = labels.pick(140, 100);
labels.setLabelsEnabled(false);
viewer.dispose();
labels.dispose();
atlas.dispose();
```

A layer borrows its supplied FontAtlas; disposing the layer or viewer leaves the
atlas usable. `await LabelLayer.create()` instead creates an owned atlas that is
released with the layer. Clear/remove detach owned scene nodes. IDs never reset
when clearing. `snapshot()` / `LabelLayer.fromJSON(atlas, snapshot)` preserve IDs,
text, paths, style, enabled state, typography controls and placement policy.

Use `layer.attach(scene, {viewport, camera, zoom})` with `Forge3DScene`,
`Forge3DSession` or a runtime directly. Reattach after camera, viewport or label
changes in this workflow; `Forge3DViewer.setLabels` handles that automatically.
Session capture and scene copying retain expanded glyph vertices. Attaching
an empty label layer to a viewer preserves terrain lighting byte-for-byte.
Label validation/budget errors clear labels and their report, and leave the viewer
ready. Camera, viewport, layer edits and recovery retry placement. Frame failures
invoke `onError` once for an ongoing failure; direct `setLabels` and `screenshot`
failures use only their throw/rejection channel.
Existing text-mesh/overlay inputs without vertices retain their rectangle path.

## Coordinates, visibility and styling

With a Camera, label positions are world `[x,y,z]`. Without one they are screen
`[pixel x,pixel y,depth]`; text starts at that baseline. Mesh bounds include
actual outlines, descenders, multiline baseline offsets, rotation and halos.
Flat-line text follows the local projected tangent for each shaped glyph in
both `center` and `along` modes, keeping each glyph upright. Text wider than
90% of the projected path is hidden (`line_too_short`). `repeatDistance` is
screen arclength; only complete instances fit on the path. Curved text remains
experimental.
Callout offsets determine placement and leader segments connect the anchor;
glyph bounds participate in collision resolution and keepouts.

`LabelStyle` matches the native defaults: size 14, color `[.1,.1,.1,1]`, white
halo at width 1.5, priority 0, depth range `[0,1]`, zoom range
`[0,3.4028235e38]`, zero rotation/offset and horizon fade angle 5 degrees.
Its fields are mutable and validated; `flags` exposes underline, smallCaps and
leader. `toJSON()` serializes the style and `toString()` identifies it.
Small caps use uppercase outlines at the requested size.

Zoom/depth bounds reject invisible labels. The native horizon-angle fade uses
world Y and camera elevation; a label at the camera's horizontal level fades to
zero. Set `horizonFadeAngle:0` or `horizonCull:false` to disable that fade.
`depthTest:true` produces camera-facing world glyph triangles and uses the scene
GPU depth buffer. Otherwise text is a screen overlay. A terrain dataset adapter
may provide `terrain.query(x,z)` to update point-label world Y.

## Font assets and layout metrics

HarfBuzz-WASM is exactly `harfbuzzjs@1.6.0`, self-hosted with its MIT notice.
Bundled Noto Sans, Arabic and Devanagari fonts are digest-pinned at an immutable
revision, with their OFL license. Default font fetches verify SHA-256 before
creating font objects. The package build verifies all shaping/font assets and
the W00 npm integrity lock. No CDN, OS font discovery or remote font dependency
is used. Browser CSP needs `script-src 'self' 'wasm-unsafe-eval'` and
`connect-src 'self'`. Worker assets retain `worker-src 'self'`.

`FontAtlas.create({fonts:[{id,data,sha256}]})` accepts TTF/OTF bytes or self-hosted
URLs, a bounded aggregate byte budget and AbortSignal. Corrupt data, integrity
mismatches and budget overflow fail before placement. `fromFont(url)` returns
an empty atlas with the exact native `missing_external_asset` diagnostic on a
missing asset. It preserves corrupt-font, allocation and abort failures.
`defaultLatin()` restricts coverage to Basic Latin; `FontAtlas.create()` loads
all three bundled script fonts. `FontFallbackRange`, `fallbacks`,
`queryFallback`, `fallbackFor`, `covers` and `validateText` expose deterministic
fallback and actual glyph coverage. A range never fabricates a missing glyph.

`shape()` returns glyph IDs, source clusters, advances, offsets and outlines.
Arabic joining, Latin ligatures/kerning and Devanagari clusters use HarfBuzz.
Typography controls include fontSize, kerning, tracking, lineHeight in pixels,
wordSpacing multiplier, baselineShift, multiline, horizontal ltr/rtl direction,
language and calloutOffset. Mixed-font runs are deterministic; this API does not
promise paragraph-level bidi layout. Tabs expand to four spaces without `.notdef`
boxes; shaping clusters still index the original text. CRLF is a line break. `measureText` and `layoutLabel` expose
layout metrics and callout anchors. Native approximate font widths are replaced
by real font metrics. Complex script plans require a prepared atlas with actual
glyph coverage; legacy glyph-name-only plans retain the exact native
`experimental_feature` decision for complex-script shaping.

## Feature ingestion and LabelPlan

`LabelLayer.fromFeatures`, `fromRows`, and `fromStyleLayer` return a
`LabelFeatureSource`. This is the label recipe that W18 can consume. It keeps
stable source IDs, properties, Point/LineString/Polygon geometry, typography,
metadata and diagnostics. Expressions support property names, `{field}`,
`get`, `concat`, `coalesce`, `upcase`, `downcase`, and `literal`.
Missing fields return `missing_label_field` before rendering. Geometry errors
retain `placeholder_fallback` or `unsupported_feature` with the feature ID.

Feature records and native LabelPlan use **map `[x,y,elevation]`**; world label
rendering uses `[x,height,z]`. Convert coordinates explicitly before drawing a
geographic plan into a world scene. In screen mode, `addPlan(plan)` preserves
accepted source IDs in its returned source-ID-to-numeric-ID map. A requested
CRS change requires `transformCoords`; W14 can supply PROJ through that adapter.
No identity transform is applied to a different CRS. Required point-terrain sampling
uses a provided sampler or returns `unavailable_terrain_sampler`; the compiler
then rejects unavailable/hidden samples as `terrain_occluded`.

`source.compileLabels({camera,viewport,terrain,...})` and
`LabelPlan.compile({labels,camera,viewport,keepouts,priority_rules,seed,...})`
return deterministic AcceptedLabel / RejectedLabel / LabelCandidate payloads.
Supported candidates include center, above, below, left, right, radial, leader,
centroid and visual_center. PriorityClass selects deterministic winners;
KeepoutRegion protects titles, legends and insets. `validate()` exposes the
compiled plan, layer-scoped diagnostics and a compiled label summary.

```ts
import {LabelPlan, KeepoutRegion, PriorityClass} from "@forge3d/web";
const plan = LabelPlan.compile({
  labels: [
    {id:"city", text:"Capital", position:[40,40,0], priority_class:"capital"},
    {id:"local", text:"Local", position:[40,40,0], priority_class:"local"},
  ],
  viewport: [100,100], seed:17,
  keepouts: [new KeepoutRegion({region_id:"legend",kind:"legend",bounds:[0,0,20,20]})],
  priority_rules: [new PriorityClass({name:"local",rank:10}), new PriorityClass({name:"capital",rank:20})],
});
const copy = LabelPlan.fromJSON(plan.serialize());
const payload = copy.toRenderPayload("webgpu");
const exportPayload = copy.toExportPayload("svg");
```

Render/export payloads contain compiler records, not a new SVG/PDF renderer.
Unsupported backends return `placeholder_fallback`. W20 owns file export.
All native rejection reasons remain: `collision`, `outside_view`,
`missing_glyph`, `priority_lost`, `keepout_region`, `terrain_occluded`,
`invalid_geometry`, `unsupported_geometry_type`, and `empty_text`.
Diagnostics retain `missing_glyphs`, `label_rejection_summary`, and exact
experimental features and support levels.

## Support boundaries and verification

| Case | Result |
|---|---|
| Point/polygon plans, world/screen point glyphs | render with coverage and valid placement |
| Flat viewer lines; configured line/road/river plans | render |
| Repeated flat paths | render deterministic arclength instances |
| Sampled visible terrain points | render |
| Arabic/Devanagari with a prepared real FontAtlas | render |
| Viewer curved label API | `experimental_feature`, feature `curved labels` |
| Curved LabelPlan | `experimental_feature`, feature `advanced curved labels` |
| Configured terrain-mode line plans | accepted, as in native; existing samples are preserved and line vertices are not automatically elevated |
| Terrain-elevated viewer lines | `experimental_feature`, feature `terrain-elevated line labels` |
| Complex script without a prepared atlas | `experimental_feature`, feature `complex-script shaping` |
| Unconfigured flat plan lines | `unsupported_geometry_type` |
| Missing/hidden required terrain | exact diagnostic and `terrain_occluded` |

The canonical case manifest is the only render-versus-diagnostic source of
truth. Its generated TS registry is checked against the JSON. Promoting a case
requires real pixels and new evidence; experimental cases never allocate a
phantom successful label. No raw IPC is needed for this workflow.

Independent fixtures are regenerated by
`python ../../scripts/generate-w13-native-oracles.py` from immutable native Git
objects. They contain 51 native compiler calls and 26 feature recipe calls,
including additional review probes; all 43 original selected native tests run.
Numerical comparisons use 1e-9 absolute precision and signed-zero normalization.
Only native Python JSON spellings inside `ordering_key` strings are omitted;
all output arrays, IDs, candidates, geometry, scores, diagnostics and reasons
are compared. The repository record at `docs/parity/w13-implementation.md`
records scope and native test coverage. Package-only copies use the adjacent
case manifest and the checks above; the repository implementation record is not
shipped in this package.

Resource accounting includes retained font bytes, native font objects, live
label state, glyph vertices, scene GPU buffers and render bundles. Font objects
and temporary shaping buffers are explicitly freed, without waiting for GC.
Large collision boxes use a bounded broad list; glyphs/placements/font sources
have finite allocation limits. Annealing uses the native f32 energy, 64-bit LCG,
cooling schedule and fixed seed over the whole placement set.

Verification is a local Chromium preflight on Windows. It is not a claim that
the separate FND branded-browser/hardware release matrix is complete.

## Line readability and error recovery

The live layer keeps shaped glyph order on reversed paths by reversing traversal
as well as making glyphs upright. This corrects the native `line_label.rs` behavior
that displays multi-glyph text backwards. Plan records and diagnostics retain the
native contract. A fitting repeated line gets one centered instance when its
repeat spacing leaves no complete interior instance; the 90% fit rule still applies.

Viewer label errors clear labels and `getLabelReport()`. A changed camera, canvas
size, layer revision, device recovery or explicit `setLabels` retries placement,
so labels return as soon as they fit. Identical attempted inputs reuse the cleared
scene until an input changes. Repeated failures from the same revision and error
cause are reported once; a successful layout resets notification suppression.

Errors raised by `setLabels` throw to its caller. Label errors first encountered
by `screenshot` reject its promise. These caller paths do not invoke `onError`;
only background frame/recovery label failures use that callback. Invalid layer
replacement also clears the old layer's pixels. Environment, scatter and probe
state still replay.
