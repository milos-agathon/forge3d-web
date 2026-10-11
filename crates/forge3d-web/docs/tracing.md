# BVH, SDF and progressive tracing

W17 provides owned CPU and WASM SAH trees, WebGPU Morton/radix LBVH construction
and refit, signed-distance scenes, and a progressive WebGPU path tracer. Select
`backend: "cpu"` explicitly to use the reference renderer. A failed WebGPU
request returns a `Forge3DError`; it does not silently change the backend.

```ts
import { PathTracer, SdfSceneBuilder } from "@forge3d/web";
const builder = new SdfSceneBuilder();
builder.addSphere([0, 0, 0], 1);
const tracer = await PathTracer.create({
  width: 320, height: 200, engine: "wavefront", seed: 1597463007,
  camera: { origin: [0, 0, 5], target: [0, 0, 0] },
});
await tracer.setScene({ sdf: builder.build() });
try {
  for await (const update of tracer.progressive({ spp: 64, updateEvery: 4 })) {
    // Linear RGB floats and typed AOVs. Each update owns its arrays.
    display(update.result.color, update.samples);
  }
} finally { tracer.dispose(); }
```

`buildBvh`, `buildBvhWasm`, and `buildBvhGpu` return a `BvhHandle` with
`intersect`, `refit`, `stats`, packed buffers and `dispose`.
`isCpu`/`isGpu` identify the build backend; `getProperties` returns owned bounds
and observed build statistics, and `validatePrimitives` checks the current inputs. Triangle IDs are
unique uint32 values in 1..0xfffffffe; 0xffffffff identifies SDF hits, and zero identifies misses; material IDs index the scene material table.
Ray directions need not have unit length. Returned `t` uses the supplied
direction, and barycentrics are ordered `(v0, v1, v2)`. Refit preserves topology
and IDs. `traceRaysGpu` runs ray batches on WebGPU; `evaluateSdfGpu` and
`evaluateSdfWasm` evaluate distance/material batches.

`SdfPrimitive` supplies sphere, box (half extents), cylinder (full height),
plane, torus, and capsule constructors. A zero-length capsule is a sphere.
`SdfSceneBuilder` supplies all six hard/smooth CSG operations. Nodes refer to
earlier nodes; the final node is the root. A snapshot owns its data. Explicit
bounds clip traversal and should contain the surface. Plane normals are
normalized. WebGPU admits at most 256 DAG nodes and reports the requested and
available limit; CPU evaluation uses a topological walk.

`PathTracer.render` starts a fresh accumulation. `progressive` adds samples to
the current accumulation; `reset` starts over. The absolute sample index and
pixel ID seed independent xorshift32 streams, so iterator update frequency
does not affect the result. Breaking an iterator releases its render session.
An `AbortSignal` cancels at a sample boundary on GPU and periodically on CPU.
Concurrent mutations are rejected. `setCamera`, `setScene`, and
`setTraversalMode` reset accumulation.

The result contains RGB `color`, `albedo`, `normal`, `direct`, `indirect`,
`emission`, and `bentNormal`; scalar `depth`, `visibility`, `ao`, and `variance`;
and uint32 `id`. Depth and ID refer to the first sample. Normals are normalized
after averaging. `renderHdr` returns W06's RGBA float `HdrFrame`; `renderRgba`
returns a tone-mapped sRGB `Frame` suitable for W06 Blob export.

Materials expose albedo, emission, metallic, roughness, anisotropic GGX axes
`ax`/`ay`, and dielectric IOR. Axes default to roughness squared (minimum 0.001);
unequal axes stretch the specular lobe. Direct lights and sampled bounces use
the same Lambert/GGX mixture. Roughness accepts the native 0..1 range, including
zero; the GGX sampling alpha retains its 0.001 numerical floor.
Lights support point, directional and disc emitters, with color, intensity and
sampling weight. Disc lights also carry a normal and radius; directional lights
carry a direction. `restir` enables
weighted reservoir candidates and temporal/spatial reuse. Compatible zero-weight
histories retain their proposal counts. History expires on deterministic
`maxTemporalAge + 1` sample windows, avoiding selection-dependent age bias. `RestirDI` exposes
the native alias-table light-management contract. `OnlineGuidingGrid` has unit
priors, directional-bin updates and normalized PDFs. Training uses inverse-PDF
weighted radiance returned after the primary diffuse bounce, before firefly
clamping. Sampling mixes 20% uniform exploration with the learned distribution. A bounded homogeneous
medium exposes RGB absorption/scattering coefficients and HG anisotropy. Surface
and in-medium light connections include Beer transmittance; scatter events sample
analytic emitters with the HG phase function.
`luminanceClamp` suppresses fireflies and scales lighting AOVs consistently.

`enableSceneCache` enables bounded content-keyed LRU result reuse. A cache hit
restores accumulation, reservoirs and guiding weights for subsequent progressive
samples; returned arrays are copied. `memoryReport` reports retained CPU/GPU/cache storage and
admitted peak bytes. `dispose` is idempotent. A lost device returns
`DEVICE_LOST`; `recover` creates or borrows a replacement device and replays the
retained scene. Failed recovery keeps rendering unavailable with `DEVICE_LOST`
until a successful explicit recovery. A supplied `GPUDevice` remains owned by the caller.

The CPU ledger counts typed storage and a per-pixel reservoir allowance. Local
stress evidence records the browser's available heap observation separately.
`gpuBytes` sums retained GPU buffer sizes. Regression/stress harnesses independently
count real allocations and destroys, including a deliberate leak negative control.

W02's `createTraceWorkerHandler` returns transferable BVH, query and SDF
packets. Ray results contain `records` (64 bytes per ray): position/t, normal/front,
barycentric/pad as float32, then id/material/steps/kind as uint32. Zero ID is a miss.
SDF results contain `distances: Float32Array` and `materials: Uint32Array`. WASM workers load the existing package loader. Browser workers have
no filesystem or native-thread dependency.

Run `npm run test:w17` for reference, shader, source and dist checks and
`npm run test:package-consumer:w17` for the installed tarball. The deterministic
fixture manifest and frozen native sources live under `tests/fixtures/w17`.
See [W17 evidence](w17-evidence.md) for observed acceptance and hardware limits.

`npm run test:package-consumer:w17 -- --soak` also runs the 600-second full-scene
local stress test. Its 32×20 viewport and observed adapter are recorded explicitly.
The W00 1920×1080 discrete/integrated hardware profiles require qualification on
their pinned hosts; local stress results do not certify those profiles.

Native public outcomes map to these browser APIs; G09/G10/G11 refer to the plan's capability rows:

| Native surface | Browser equivalent | Proof |
| --- | --- | --- |
| `render_aovs` (G11) | `PathTracer.render` returns every typed AOV | convergence and feature probes |
| `save_aovs` (G11) | `encodeTraceAovs(result, basename)` returns named EXR/PNG Blobs | all six HDR AOVs decoded and checked; visibility PNG decoded |
| `iter_tiles` (G11) | `iterTraceTiles(width, height, tileSize)` yields scanline rectangles with clipped edges | unit coverage exactly once; installed edge-tile probe |
| `TracerEngine` (G11) | `engine: "megakernel"` or `"wavefront"` | exact engine hashes and queue checks |
| `BvhHandle.is_gpu/is_cpu/get_properties/validate_primitives` (G09) | `isGpu/isCpu/getProperties/validatePrimitives` | irregular GPU/WASM trees and unit validation |
| `make_camera` (G11) | typed `TraceCamera` in `PathTracer.create`/`setCamera`; aspect follows output dimensions | geometry, camera and replay probes |
| `make_sphere` (G10/G11) | `SdfPrimitive.sphere` plus typed `TraceMaterial` | sphere hits and material probes |
| `add_triangle` (G09/G11) | `TraceSceneInput.triangles` through `setScene` | triangle/refit and nearest-hit probes |

`encodeTraceAovs` uses W06's EXR encoder for albedo, normal, depth, direct, indirect
and emission; visibility becomes an 8-bit PNG. Browser callers own the returned
Blobs and choose a download or storage destination. `iterTraceTiles` partitions
output coordinates; progressive rendering retains the full-frame accumulation.
