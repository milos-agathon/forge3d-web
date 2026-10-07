# W15 — geometry, mesh processing, IO and buildings

W15 implements G05a/G06/G07/G08 and closes G05b as a diagnostic contract.
The [package guide](../../crates/forge3d-web/docs/geometry-mesh-io.md) describes
all public APIs, coordinate conventions, file formats and ownership.

## Native audit and numeric controls

The implementation was checked directly against archived sources, independently
of previous completion claims. `scripts/generate-w15-native.py` compiles the
archived Rust CPU kernels at `bf8db93233e5158f6d226991fc5d230832c2d806` in an
isolated reference crate. It records nine original source digests and sixteen
outputs in `crates/forge3d-web/tests/fixtures/w15/mesh-io-v1.json`. Only feature
markers and PyO3 wrappers are removed from the adaptive/UV reference scaffold;
the numeric kernel bodies are preserved. Fifteen browser comparisons check
exact counts and oriented topology, and maximum absolute position/normal/UV/TBN
error <=1e-5. Loop and adaptive outputs allow vertex reordering with exact
oriented connectivity after remapping. Spherical unwrap controls use the same
input f32 coordinates to avoid an equivalent 0/1 seam changing sides with
JavaScript versus Rust trigonometric rounding.

[The native audit](w15-native-audit.json) pins 33 historical/final native suites
and 117 definitions, including `test_mesh_tbn.py`'s imported canonical TBN class.
It names concrete browser test ports and explains the Python/filesystem and
W18 MapScene adaptations. Its generator rejects missing browser ports. Unit
tests recheck the source digests against Git and the frozen native sample
CityJSON against its archived bytes; that sample produces all five real meshes.
This is a source and outcome audit, not a claim that PyO3 or Python runs in browsers.

Two deliberate corrections preserve useful existing browser behavior. The
native primitive box has malformed face coordinates; browser unit boxes have
[-0.5,0.5] bounds, 24 face vertices, 12 triangles and a closed welded boundary.
The archived `src/mesh/tbn.rs` reconstructs bitangents from normals/tangents and
loses mirrored UV handedness. Its result is retained as `legacyTbnPlane` for
inspection. W15 uses W04's corrected area-weighted handed tangent generator;
ordinary/mirrored controls match the separate native geometry tangent helper.

Native GeoJSON roof inference supplies metadata and scalar presets, rather
than generating procedural pitched geometry. CityJSON retains its supplied
roof surfaces. Native public 3D Tiles building loading is incomplete; W15
returns `underdeveloped` with `python_public_3dtiles_incomplete`. W16 owns real
tileset traversal and b3dm extraction, consuming this plain glTF/GLB decoder.
Draco/PLY remain outside W15's required scope. The W18 product MapScene wrapper
remains separately owned; direct building geometry and diagnostic contracts
are implemented here.

## Implementation and admission

Owned packed f32/u32 meshes support primitives, holed signed extrusion,
thick polylines, ribbons/tubes, welding, topology validation, normal/UV/TBN
generation, Loop/crease/adaptive subdivision, displacement, affine transforms,
QEM LOD and bounded shared GPU instancing. Simplification explicitly clears
UV/TBN; textured HLOD rejects destructive simplification and retains attributes
when its ratio is one. GPU batches carry UVs, handed tangents and actual scene
material indices. Instanced tangents use the linear transform, orthogonalize
against inverse-transpose normals, and flip handedness for reflections.
Material collection copies preserve slot allocation; exhausted monotonically
allocated slots reuse vacant indices without invalidating live materials.

Browser IO supports asynchronous URL/File/Blob/Response/ArrayBuffer/stream
sources, cancellation, progress and byte budgets; exporters produce Blobs or
W02 storage streams. OBJ/MTL retain assignments and paths; STL preserves facets;
plain glTF/GLB supports offsets/strides/normalized attributes/sparse accessors,
external/data/BIN buffers and local primitive/node/material metadata. Required
extensions and malformed data fail structurally. External caller resolvers
are raced with cancellation, so disposal settles even an uncooperative resolver.
Public image codecs release temporary bitmaps; HDR wraps W04 RGBE with modern
scanline export. Opaque PNG is exact; JPEG/alpha and RGBE precision limitations
are documented.

Building layers preserve IDs, bounds, highest LOD, ground/height, CRS,
roof/material inference, MultiPolygonZ and BuildingPart geometry. CityJSON
quantization is expanded before W14 PROJ reprojection, with local origin
subtraction before f32 conversion. Scene additions stage validation, LOD and
material allocation before committing. Empty geometry, missing path/UV/format,
Pro gates, placeholder fallbacks and requested textured building output carry
blocking diagnostics. Valid assets/UVs still cannot imply textured success.

CPU outputs are budget-admitted (default 256 MiB), including generated normals
and tangents. Shared GPU resource admission rejects oversized replacements
atomically. W02 recursively transfers result buffers and deduplicates them;
caller copies remain intact. Worker CPU kernels are synchronous; disposing the
pool settles callers, and terminating its owned worker stops computation.
Layer/scene/runtime disposal releases their respective copies and allocations.

## Verification

Independent manually encoded OBJ/MTL/STL/plain glTF/GLB fixtures prevent exporter
and importer mistakes from serving as each other's oracle. The installed npm
consumer runs fifteen cube/plane/tube/ribbon/extrusion format round trips under
strict package-local CSP. Format-preserving topology/counts are exact; OBJ
vertex encounter order is remapped using all carried attributes. STL verifies
every ordered facet coordinate and geometric facet normal; it expands vertices
and cannot carry UV/TBN. Round-trip Hausdorff and bounds errors are normalized
by scene diagonal and bounded at 1e-5. GLB carries exact f32/u32 attributes.

The same source/dist example tests real module-worker transfers in both
directions, PNG/HDR, cancellation, streams, scalar building materials/IDs/LOD,
CityJSON with real PROJ, UV/TBN rendering, replacement admission, resize and
actual destroyed-device recovery. Thirty replacements retain 12620 scatter GPU
bytes; an oversized replacement is rejected while preserving the frame, and
clearing batches reports zero scatter allocation. UV/TBN rendering covers
1152 pixels and matches the CPU-transformed control with zero normal/albedo
error; removing UVs produces a 0.587695 maximum difference. Recovery creates
two runtimes and replays the two visible buildings byte for byte.

The W15 installed tarball gate is included in `.github/workflows/web.yml`.
Its report is `crates/forge3d-web/test-results/w15-package-consumer.json`.
Chromium preflight is used; this evidence does not change physical browser or
hardware release qualification.

Verification commands (run from `crates/forge3d-web`):

```powershell
$env:CARGO_TARGET_DIR = 'C:/devin-target/forge3d-web'
npm run build
npm run test:unit -- --maxWorkers=4
npm run test:api
npm run verify:parity
npm run test:package
npx playwright test tests/playwright/w15_geometry.spec.ts tests/playwright/w09_scatter_probes.spec.ts tests/playwright/w04_materials.spec.ts --project=chromium-preflight
npm run test:package-consumer:w15
```

Rust scatter boundary and WGSL validator checks supplement the browser gates.
The first full parallel unit run hit the existing W06 muxer's five-second
wall-clock timeout under load; the bounded-worker rerun is recorded with the
final results. No W06 behavior or timeout was changed.

Final verification on 2026-10-07 passed the full build, 1034 unit tests,
public API/declaration gates, all fifteen parity checks, nine documentation
checks, 118 browser-harness cases and 609 infrastructure cases (one existing
Unix-only skip on Windows). The W15/W04/W09 browser run passed 30 cases with
one existing W09 baseline-fixture skip. Five core scatter boundary tests and
the web scatter display/capture WGSL validator passed. The installed tarball
consumer passed all six workflows without page errors or external requests.
