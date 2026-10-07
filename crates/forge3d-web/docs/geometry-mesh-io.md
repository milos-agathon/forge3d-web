# Geometry, mesh IO and buildings

W15 provides owned indexed meshes, processing, browser file IO and scalar building
materials. Run `npm run dev` and open `/examples/mesh-buildings.html?dist` for the
render/export example. `npm run test:package-consumer:w15` installs an npm tarball
in a separate consumer, compiles its TypeScript, and runs the same example under
a policy permitting only package-local scripts, workers and data.

```ts
import {
  generatePrimitive, attachMeshTangents, MeshLayer, Forge3DScene,
  loadBuildings, loadGltf, exportMesh, transferMesh,
} from '@forge3d/web';

const mesh = attachMeshTangents(generatePrimitive('sphere', {
  rings: 16, radialSegments: 32,
}));
const scene = Forge3DScene.create();
const layer = new MeshLayer(mesh);
scene.setScatterBatches([layer.toBatch()]);
const buildings = await loadBuildings(new URL('./buildings.geojson', location.href));
buildings.addToScene(scene, {lodRatios: [1, .5], lodDistances: [60]});
runtime.setScene(scene.snapshot()); // an existing Forge3DRuntime
runtime.render();

const asset = await loadGltf(file); // File, Blob, URL, Response or byte stream
const glb = exportMesh(asset.primitives[0]!.mesh, 'glb'); // downloadable Blob
const transferable = transferMesh(mesh); // copies; caller mesh stays intact
```

## Buffers, axes and lifetime

`MeshBuffers` contains packed `Float32Array` positions/normals (xyz), UVs (uv),
handed tangents (xyzw), and triangle `Uint32Array` indices. Absent attributes are
zero-length arrays. Input accepts optional attributes. Indices, sizes, finite
values and allocation budgets are validated before use. The default CPU mesh
budget is 256 MiB. IO `maxBytes` also bounds decoded glTF buffers/accessors.

Constructors return owned arrays. Processing leaves caller buffers unchanged.
`transferMesh()` returns a dedicated mesh copy and its five `ArrayBuffer`s;
pass its `transfer` list to W02's message client/pool. `createMeshWorkerHandler()`
implements subdivision, weld, simplify and displacement, and can be registered
with `serveForge3DMessagePort(port, {run: handler})` in a module Worker.
Mesh results transfer recursively and detach their worker arrays. Cancellation
settles the caller and prevents committing a superseded result; individual CPU
kernels run synchronously inside the worker. Terminate an owned Worker after
disposing its pool to stop in-flight computation.

`MeshLayer` owns geometry and instance transforms; `dispose()` releases its CPU
arrays. Committed scene/runtime batches own copies, so disposing a layer does
not invalidate a rendered scene. Clear runtime/scene batches to release GPU
buffers. Shared scatter rendering provides culling, LOD, instancing, IDs/AOVs,
resource admission, replacement and device-loss replay through `Forge3DSession`.
Material indices refer to the scene's material collection (default zero).

Primitive planes are XY, cylinders/cones are Y-up. Extrusion and buildings use
source Z-up coordinates. Building rendering maps `(x,y,z)` to `(x,z,-y)`.
Transform/instance matrices are row-major affine 4x4, with translation at
3/7/11. Reflections reverse mesh triangle winding and tangent handedness;
normals use the inverse transpose. Building `origin` is subtracted in source
coordinates before f32 conversion. For large coordinates, choose a local origin.
`loadBuildings({crs, targetCrs, transformer})` uses W14 PROJ and transforms
CityJSON vertices after applying its quantization transform.

## Constructors and processing

- `generatePrimitive`: plane, unit box, sphere, cylinder, cone, torus.
- `extrudePolygon`: outer ring and holes, signed height, base elevation, caps
  and walls with normals and UVs.
- `generateThickPolyline`, `generateRibbon`, `generateTube`: taper, miter/bevel
  joins, per-point styles, depth offset and parallel-transport tube frames/caps.
- `validateMesh`: indices, degeneracy, duplicates, non-manifold and boundary
  edges; `weldMesh`: quantized buckets, UV seam preservation and index remap.
- `recomputeMeshNormals`, `planarMeshUv`, `sphericalMeshUv`, `attachMeshTangents`:
  explicit normal/UV/TBN generation. UV edits and displacement clear stale TBN.
- `subdivideMesh`: Loop boundary and crease rules; `subdivideMeshAdaptive`:
  native global level selection from the longest edge and maximum shared-edge
  dihedral angle, bounded by the requested level limit.
- `displaceHeightmap`: clamped bilinear UV or XY sampling;
  `displaceProcedural`: native sine/cosine displacement.
- `transformMesh`, `centerMesh`, `scaleMesh`, `flipMeshAxis`, `swapMeshAxes`;
  `mergeMeshes`, `meshBounds`, `meshBytes`.
- `simplifyMesh` and `generateMeshLods`: deterministic QEM geometry/normal
  simplification. Simplified outputs clear UV/TBN because the native QEM kernel
  does not interpolate them. Supply explicitly generated UV-aware LODs for
  textured meshes. Textured HLOD accepts `simplifyRatio: 1`, preserving UVs/TBN;
  a request to simplify those attributes fails structurally.

## Browser IO

`loadMesh(source, {format})` handles OBJ, STL, glTF and GLB. `loadObj` returns
mesh plus material libraries, object/group/material-to-triangle metadata;
`loadGltf` returns all primitive meshes with mesh/primitive indices, raw material,
node and scene metadata. Primitive buffers remain in local mesh coordinates:
apply glTF node transforms explicitly when building a scene.

OBJ supports negative indices, polygon fans, triplet deduplication, missing
normals, UVs and MTL scalar/texture-path metadata. `parseMtl`/`encodeMtl` and
`parseObj`/`encodeObj` preserve group/object/material assignments.
STL supports binary and ASCII triangles; it cannot carry UVs or material groups.
Its decoder produces three vertices per facet. Use geometric Hausdorff and
triangle counts when comparing an indexed source with STL.

Plain glTF 2.0/GLB decoding handles accessor offsets, strides, normalized
integer attributes, sparse overrides, unsigned indices, data URIs, GLB BIN and
relative external buffers. `baseUrl` or `resolveUri(uri, signal)` resolves
external resources without a filesystem. Required extensions, Draco payloads,
non-triangle modes, malformed bytes and excessive allocations return typed
errors. `encodeGlb` writes exact f32/u32 attributes, valid position bounds and
scene metadata. W16 owns b3dm extraction/traversal and will consume this decoder.

`exportMesh` returns OBJ/STL/GLB Blobs. `exportMeshToSink` consumes W02 byte sinks
(WritableStream, OPFS and File System Access). `MeshIo` tracks pending reads;
dispose cancels them. Source reads support progress, abort and byte budgets.
Public `loadHdr` consumes W04's RGBE decoder; `exportHdr` writes Radiance RGBE
with modern scanlines. RGBE is quantized HDR; it is not a lossless float format.
`loadImage` and `exportImage` use browser bitmap/Canvas codecs for PNG/JPEG/WebP
and release temporary ImageBitmaps. Browser alpha premultiplication and lossy
formats can affect pixel fidelity; opaque PNG round trips are tested exactly.

## Buildings and diagnostics

GeoJSON Polygon/MultiPolygon buildings extrude footprints, including courtyards,
with stable IDs, heights, ground elevations, native roof inference and scalar
material presets. Native GeoJSON roof inference is metadata: it does not generate
procedural pitched roofs. CityJSON preserves actual supplied roof surfaces,
quantized vertices, highest integer LOD, Building/BuildingPart IDs and CRS;
MultiSurface/CompositeSurface/Solid use the shared `meshFromMultiPolygonZ` decoder.
`BuildingLayer.fromGltf` provides a geometry/scalar-material bridge from plain
decoded primitives. `addToScene` stages validation and builds bounded LOD and
instance batches; re-adding the same named layer replaces its batches.

Textured buildings remain diagnostic-only, matching the final native contract.
`diagnoseBuildingTextures` preserves missing path/UV, unsupported format,
placeholder fallback, unsupported output and Pro-gated diagnostics with native
details. Requested CityJSON/glTF textures are detected automatically. Empty geometry reports a blocking placeholder diagnostic. Even a
valid asset and UV combination reports unsupported textured rendering;
`addToScene()` blocks reports with errors. A scalar fallback cannot be reported
as textured success. Ordinary mesh material textures are supported separately.

`loadBuildingTilesMetadata` preserves the native public 3D Tiles building path's
`underdeveloped` result and blocking `python_public_3dtiles_incomplete` diagnostic.
It reads/validates metadata only. W16 implements real tile traversal and b3dm;
there is no synthetic success or empty mesh advertised as rendered buildings.

## Verification

`tests/fixtures/w15/mesh-io-v1.json` contains independently executed archived
native Rust results. `scripts/generate-w15-native.py` compiles those exact blobs
and records their digests. Fifteen cases enforce exact topology/counts and f32
position/normal/UV/TBN error at most 1e-5; Loop/adaptive cases permit only vertex
reordering. A sixteenth reference exposes the legacy mesh TBN convention.
The browser retains W04's corrected mirrored handedness; the archived mesh
helper reconstructs its bitangent and loses that sign. The native unit-box
constructor also has malformed face coordinates; browser boxes retain unit
bounds, 24 vertices, 12 triangles and closed topology instead of copying that
defect. These deliberate differences are recorded in the W15 parity evidence.
The native audit records 33 suites (117 test definitions including the imported
TBN class) with source hashes, named browser ports and explicit W18 boundaries.
The actual native sample CityJSON is checked byte for byte and parses into five
meshes. Independent manually encoded OBJ/MTL/STL/glTF/GLB fixtures and their hashes avoid
using this package's exporters as importer oracles. Browser format round trips
enforce exact triangle topology where preserved and Hausdorff at most 1e-5 of
scene diagonal. TBN rendering compares a transformed mesh against its instanced
equivalent and checks a missing-UV negative control.

Run `npm run test:w15`, `npm run test:api`, and
`npm run test:package-consumer:w15`. The package gate exercises real WebGPU,
worker transfer in both directions, image/HDR/file IO, scalar materials, LOD,
30 replacement cycles, memory rejection, resize and device-loss replay.
