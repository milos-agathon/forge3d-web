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
miter limit. Polygons triangulate concave boundaries and holes; nonzero
`extrusion` adds a raised roof and walls. `addGraph` validates all node references
and draws edges below nodes. Layer `zOrder` defines stable draw order.

`setOit("auto")` uses weighted blended transparency (WBOIT). Standard alpha
compositing follows draw order. Explicit dual-source mode uses the negotiated
WebGPU feature when available and otherwise selects WBOIT;
`getVectorReport()` exposes requested/effective modes and the fallback reason.
All compositing uses premultiplied alpha. Projection, elevation, conservative
frustum culling and stable indirect compaction run in compute; `setCulling("cpu")`
selects the deterministic Rust reference, also used when storage-buffer limits
prevent the compute path. Color, pick, depth and AOV variants share coverage and
geometry, including the AA fringe and atlas alpha cutoff.

`VectorPicker.point`, `rect`, and `lasso` return visible pixel hits with feature
ID, layer, geometry kind, properties, depth and world position. Area queries
deduplicate IDs and sort numerically. Coordinates use device pixels with an
upper-left origin. `bind(canvas, options)` converts CSS pointer coordinates,
supports click/hover callbacks and selection, and returns a detach function.
Dispose the picker to detach all listeners. Abort signals are checked before and
after readback and during area scans. `pickVectorTerrain` casts a camera ray into
the same bilinear heightfield and returns elevation, normal and distance.

Selections support tint, outline, glow and deterministic time-based pulse;
outline width and glow radius are bounded at 32 device pixels.
multiple named sets and hover survive snapshots/recovery. GPU textures and
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
18 pinned native implementation, shader, test and example sources. Browser tests
reject empty renders and exercise ID/color alignment, CPU/GPU output, WBOIT order
independence, fallback, drape, HDR/AOV integration, resize, recovery and memory.
