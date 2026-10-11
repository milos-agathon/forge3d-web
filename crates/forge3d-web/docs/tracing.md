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
`intersect`, `refit`, `stats`, packed buffers and `dispose`. Triangle IDs are
unique nonzero uint32 values; material IDs index the scene material table.
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

Materials expose albedo, emission, metallic, roughness and dielectric IOR.
Lights support point, directional and disc emitters, with color, intensity and
sampling weight. Disc lights also carry a normal and radius; directional lights
carry a direction. `restir` enables
weighted reservoir candidates and temporal/spatial reuse. `RestirDI` exposes
the native alias-table light-management contract. `OnlineGuidingGrid` has unit
priors, directional-bin updates and normalized PDFs. A bounded homogeneous
medium exposes RGB absorption/scattering coefficients and HG anisotropy.
`luminanceClamp` suppresses fireflies and scales lighting AOVs consistently.

`enableSceneCache` enables bounded content-keyed LRU result reuse. A cache hit
restores accumulation, reservoirs and guiding weights for subsequent progressive
samples; returned arrays are copied. `memoryReport` reports retained CPU/GPU/cache storage and
admitted peak bytes. `dispose` is idempotent. A lost device returns
`DEVICE_LOST`; `recover` creates or borrows a replacement device and replays the
retained scene. A supplied `GPUDevice` remains owned by the caller.

W02's `createTraceWorkerHandler` supports transferable BVH, query and SDF
requests. WASM workers load the existing package loader. Browser workers have
no filesystem or native-thread dependency.

Run `npm run test:w17` for reference, shader, source and dist checks and
`npm run test:package-consumer:w17` for the installed tarball. The deterministic
fixture manifest and frozen native sources live under `tests/fixtures/w17`.
See [W17 evidence](w17-evidence.md) for observed acceptance and hardware limits.

`npm run test:package-consumer:w17 -- --soak` also runs the 600-second full-scene
local stress test. Its 32×20 viewport and observed adapter are recorded explicitly.
The W00 1920×1080 discrete/integrated hardware profiles require qualification on
their pinned hosts; local stress results do not certify those profiles.
