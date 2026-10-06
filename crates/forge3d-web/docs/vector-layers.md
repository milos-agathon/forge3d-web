# Vector layers and picking

`VectorLayers` owns batched points, polylines, polygons with holes, and graphs.
`VectorLayer` handles support transactional geometry/style edits. Every feature
has a unique nonzero uint32 ID; edits preserve it, zero is background, and deleted
IDs are removed from named selections and hover state. Snapshots and copies own
their arrays and properties. A scene observes edits to its attached layer collection
when its next revision is committed.

```ts
import { Forge3DScene, VectorLayers, VectorPicker } from "@forge3d/web";
const vectors = new VectorLayers();
const rail = vectors.add({
  name: "rail",
  style: { drape: true, drapeOffset: 0.5, lineWidth: 2,
    cap: "round", join: "miter", color: [1, 0.3, 0.1, 1] },
  features: [{ id: 42, kind: "line", positions: [[-1, 0, 0], [1, 0, 0]] }],
});
const scene = Forge3DScene.create();
scene.addTerrain(terrain);
scene.setVectorLayers(vectors);
session.setScene(scene);
const picker = new VectorPicker(session, vectors);
const hit = await picker.point(100, 80, { signal });
vectors.setSelection("active", hit ? [hit.id] : [], { outline: true });
session.render();
```

Positions are XYZ in the renderer’s centered, Y-up world. Widths, cap sizes,
point sizes and selection outline/glow radii use device pixels. Draping replaces Y
with bilinear displayed terrain elevation plus `drapeOffset`, clamps outside
terrain bounds, rejects nodata, and subdivides lines and polygon interiors by terrain spacing.
Terrain domain and exaggeration apply before the offset. Direct runtime/viewer
`setVectorLayers(vectors, terrain)` accepts the same terrain input used by
`setTerrain`; scene commits derive it from their terrain node.

Point shapes are circle, square, diamond, triangle, texture atlas and sphere
impostor. Atlases use RGBA8 bytes and fixed square tiles; `atlasTile` selects a
tile, `lodThreshold` suppresses points smaller than the specified pixel size.
Polylines support butt/round/square caps and miter/bevel/round joins, with a
miter limit. Miter joins include the bevel wedge and their additional tip;
exceeding the limit produces bevel coverage. Polygons triangulate concave boundaries and holes; nonzero
`extrusion` adds a closed prism with a raised roof, base and walls. `addGraph` validates all node references
and draws edges below nodes. `edgeStyle.drape` and `nodeStyle.drape` apply
independently; `input.drape` overrides both only when explicitly set. Layer `zOrder` defines stable draw order.

A feature is opaque when `color.a * opacity === 1`. Opaque geometry writes
terrain/scene depth first, so the nearest surface owns its visible color and pick
ID in either draw order. Translucent geometry follows in a depth-tested OIT pass,
then the pick pass runs. AA and atlas coverage are shared by those passes.

`setOit("auto")` selects dual-source when the negotiated device supports
`dual-source-blending`. Otherwise it selects WBOIT and reports
`fallbackReason: "dual-source-blending-unavailable"`. Explicit dual-source has
the same fallback; explicit WBOIT remains order independent at different depths,
and standard transparency follows draw order. `getVectorReport()` reports the
requested and effective modes.

Dual-source uses the exact native `1f4084a` medium controls: alpha correction
1.1, depth weight scale 1, maximum fragments 8, and premultiply factor 1.
`color0` contains premultiplied corrected alpha; `color1` contains corrected
alpha, depth weight, coverage, and `1 / 8`. Both destination components use
`OneMinusSrc1Alpha`, followed by the native compose, Reinhard and gamma equations.
It is checked against an independent CPU equation in both draw orders.

Projection, expansion, conservative frustum culling and stable indirect
compaction run in compute. A hierarchical parallel prefix sum preserves source
vertex order. CPU and GPU clip storage share 19 fractional bits to avoid backend
multiply reassociation differences while preserving existing subpixel precision
assertions. `setCulling("cpu")` selects `project_and_cull`, also used when device
storage limits prevent the compute path. `readVectorProjection()` is a diagnostic
readback of actual GPU output and the independent CPU output, including exact
byte comparison.

The capture object-ID AOV uses reserved `AOV_ID_VECTOR = 0xffffffef` for every
vector fragment. Terrain uses `AOV_ID_TERRAIN = 1`; scene-node IDs plus 2 must
stay below the vector reservation, and water starts at `0xfffffff0`. Full uint32
feature IDs are available through the vector pick map. Flat draped polygon
normals face the camera and match terrain's `[0, 1, 0]`. Offline samples project
vectors with each sample's jittered matrix; the reference ID AOV uses the
unjittered camera.

`VectorPicker.point`, `rect`, and `lasso` return visible pixel hits with feature
ID, layer, geometry kind, properties, depth and world position. Area queries
deduplicate IDs and sort numerically. Coordinates use device pixels with an
upper-left origin. Point queries read one pixel; rectangle and lasso queries read
their clamped bounding box. Clean committed pick targets are reused without a
new render. `bind(canvas, options)` converts CSS pointer coordinates,
supports click/hover callbacks and selection, and returns a detach function.
Hover input is coalesced behind one in-flight readback and clicks take priority.
Dispose the picker to detach all listeners. Abort signals are checked before and
after readback and during area scans. `pickVectorTerrain` casts a camera ray into
the same bilinear heightfield and returns elevation, normal and distance.

Selections support tint, outline, glow and deterministic time-based pulse;
outline width and glow radius are bounded at 32 device pixels.
Multiple named sets and hover survive snapshots/recovery. There is no arbitrary
4096-highlight cap; actual device and memory limits remain enforced. Sorted IDs
use binary lookup. A single neighbourhood traversal per pixel uses the largest
active radius, skips empty selection bounds, and caches tint/outline/glow pixels
until geometry, camera, selection, hover or time changes. Selection, hover and time commits update the highlight buffer without rebuilding
geometry or creating pipelines. Geometry/style edits rebuild vertex buffers;
pipelines are reused per device, mode, entry point and target format.
`getVectorReport()` exposes `pipelineCreations`, `vertexBufferCreations`,
`pickRenderCount`, and `pickReadbackPeakBytes`. A scene with absent `vectors`
keeps runtime vectors; `vectors: null` removes them. Session budget admission and
scene upload share one compiled packet. Geometry/atlas limits throw the public
`Forge3DError` with code `RESOURCE_LIMIT_EXCEEDED`. GPU textures and
buffers are admitted together before allocation, resize is transactional,
readback staging is released on success or error, and disposal releases all
resources. Runtime, scene/session, viewer and OffscreenCanvas worker paths share
the renderer. Installed packages contain every module, shader in WASM, and the
Luxembourg rail fixture.

Examples: [Luxembourg rails](../examples/luxembourg-vector.html) and
[picking](../examples/vector-picking.html). The Luxembourg network is converted
from the pinned native GeoPackage; default relief is a clearly identified
demonstration heightfield because the native example’s DEM was externally supplied.
`scripts/generate-w12-native-fixtures.py --check` verifies the conversion and the
22 pinned native implementation, shader, control, pipeline, test and example
sources. The original 18 files are also checked byte-for-byte against `1f4084a`. Browser tests
reject empty renders and exercise ID/color alignment, CPU/GPU output, WBOIT order
independence, fallback, drape, HDR/AOV integration, resize, recovery and memory.

W12 acceptance uses `npm run test:w12` (14 unit tests plus the vector and camera browser suites),
`npm run test:unit` (768 cases), `npm run test:api`, `npm run verify:parity`,
`python scripts/generate-w12-native-fixtures.py --check` (22 sources),
`cargo test -p forge3d-core --features webgpu` (379 cases), and
`cargo test -p forge3d-web` (189 cases), with
`CARGO_TARGET_DIR=C:\devin-target\forge3d-web`. Run
`npm run test:package-consumer:w12` last on a clean commit and immediately copy
`test-results/w12-package/evidence.json` outside that directory.

The earlier clean-consumer evidence revision is
`7b18ec1fabe32ae0f405601cf0df9bf8844d27c9`, tarball SHA-256
`df1e29580f7fb8bf27e59fac1c7d4e2ca273b0df85bfa8c5b86cb346b0d6f8c1`.
The earlier final clean-commit rerun is retained at
`C:\devin-target\w12-evidence\final-evidence.json` with its exact revision
and digest. The corrections to `55cfe2c` retain their own final evidence at
`C:\devin-target\w12-evidence\r123-final-evidence.json`. They keep vector
accumulation in scene colour, apply W11 tone mapping and output encoding once,
and invalidate pick and selection/hover caches after camera changes.
[W12 verification](w12-verification.md) maps the findings to browser tests and
documents both the earlier evidence and these corrections.
