# Terrain scatter and local lighting probes (W09)

Import these APIs from `@forge3d/web`. Scatter batches and probe sets take
ownership of copies; snapshots can cross a worker boundary and be retained for
device recovery. Runtime commits admit the GPU allocation before creating it.

## Coordinates and population

`TerrainScatterSource` uses y-up world coordinates. By default x/z span
`[0, terrainWidth]`, matching the native scatter helper. Set `origin` to the heightfield's minimum x/z, e.g. `[-32, -32]` for a centered 64-unit terrain.
Set `domainMin` and `zScale` to the terrain's domain minimum and exaggeration;
placement y is `(height - domainMin) * zScale`.

```ts
import {
  TerrainScatterSource, TerrainScatterBatch, seededScatterTransforms,
  autoScatterLodLevels, TerrainLightingProbes,
} from "@forge3d/web";

const source = new TerrainScatterSource(heights, width, height, {
  terrainWidth: 64, origin: [-32, -32], domainMin: 0, zScale: 1,
});
const transforms = seededScatterTransforms(source, {
  seed: 42, count: 100, scale: [0.8, 1.4], edgeMargin: 2,
  filters: { maxSlopeDegrees: 30 }, minDistance: 0.5,
});
const batch = new TerrainScatterBatch({
  levels: autoScatterLodLevels(mesh, { distances: [30, 100] }),
  transforms, color: [0.25, 0.4, 0.1, 1], maxDrawDistance: 500,
  hlod: { distance: 150, clusterRadius: 32, simplifyRatio: 0.2 },
  wind: { enabled: true, amplitude: 1, speed: 0.5, rigidity: 0.3 },
  terrainBlend: { enabled: true, buryDepth: 0.75, fadeDistance: 2.5 },
  terrainContact: { enabled: true, distance: 3, strength: 0.35 },
});
scene.setScatterBatches([batch]);
scene.setTimeSeconds(0.37);
session.setScene(scene);
```

Matrices are row-major affine 4x4 values; translation occupies offsets 3, 7,
and 11. `makeScatterTransform` uses native yaw degrees and uniform scale.
Random and jittered-grid placement use NumPy-compatible SeedSequence/PCG64.
`gridScatterTransforms` also accepts a density `mask`: a legacy heightmap-sized
`Float32Array`, or `{ data: Float32Array, width, height }` at any resolution.
Rectangular masks are bilinearly resampled in native RNG order. It also accepts
`densityScale`, slope/elevation filters, edge margin and minimum distance.
Impossible requested populations throw `INVALID_INPUT`.

LOD thresholds increase strictly; only the last level may omit a threshold.
HLOD uses native three-dimensional grid cells, leaving singleton cells as
individual draws. Clusters merge the coarsest geometry, use the mean instance
translation as their center, and include mesh radius and instance scale in the
activation sphere. Activation uses `distance(eye, center) - radius`, strictly
between the HLOD threshold and draw distance. Covered instances stop drawing;
instances still obey their own draw-distance cull. Cluster draws have zero wind.
Population bounds contain every LOD and maximum wind offsets; the static HLOD
sphere is separate from those conservative bounds. Containment slack is exactly
the actual population diagonal times `1e-5`, including tiny scenes.
QEM ports the native midpoint quadric heap with deterministic edge ordering,
generation checks, boundary costs and recomputed normals. It has no 4096-triangle
cap. The 4096-triangle halving workload measured 2082.11 ms before and 64.51 ms
after this change on the same local workload.

`setTimeSeconds` on the runtime, viewer or session selects deterministic wind
time. `renderFrames` advances this time to the frame timestamp automatically.
Disabled wind, zero amplitude, and rigidity 1 with zero gust preserve the static
frame. Viewers request a render after setters and retain batches, probes and
time for their existing device-loss recovery.

## Bake, apply and inspect probes

```ts
const probes = await TerrainLightingProbes.bake(source, {
  grid: { origin: [-24, -24], spacing: [16, 16], dims: [4, 4],
          heightOffset: 5, edgeBlend: [8, 8] },
  skyColor: [0.6, 0.75, 1], rayCount: 64,
  reflectionResolution: 8, reflectionSamples: 32,
  memoryBudgetBytes: 64 * 1024 * 1024,
});
scene.setLightingProbes(probes);
probes.setDebug("weight"); // also "irradiance", "reflections", "none"
probes.setStrength(0.8, 0.5); // irradiance, reflection
runtime.setLightingProbes(probes); // snapshots the current settings
console.log(runtime.getProbeMemoryReport());
console.log(runtime.getScatterStats(), runtime.getScatterMemoryReport());
runtime.setLightingProbes(null);
runtime.setScatterBatches([]);
probes.dispose();
```

The WASM baker ports the native bf8db93 analytical SH L2 and reflection code.
SH coefficients retain the native z-up basis; runtime sampling converts y-up
normals. Cubemaps use native face ordering, GGX mip prefiltering and native
bilinear texel coordinates. Runtime sampling blends neighboring probes, fades
at grid edges, applies roughness mips and box projection, and feeds world and
terrain PBR lighting. Zero strengths reproduce the unprobed frame.

`reflectionMaterial` accepts the native capture material: albedo mode,
colormap range, overlay stops, grass/dirt/rock/snow colors, snow/rock layers and
wetness. `getTerrainProbeMaterialDefaults()` returns a complete editable
snapshot. `reflectionLighting` accepts directional light settings and an
equirectangular interleaved RGB Float32Array environment with intensity and
rotation. Irradiance uses the analytical constant-sky input. Explicit bake
settings are retained independently of runtime materials and IBL.

Baking runs one grid request in a self-hosted module worker. An AbortSignal
terminates a dispatched request without blocking the browser. Missing worker
support raises `UNSUPPORTED_FEATURE`.
`grid` supports up to 4096 irradiance probes; optional `reflectionGrid` supports
up to 256 reflection probes. Omission retains the combined-grid API, limited by
the reflection count. Counts are dimension products, so a `4096 x 1` irradiance
grid is valid. Explicit snapshots pair `reflectionGrid` and
`reflectionPositions`; legacy snapshots share their placement fields.
Other limits are 64x64 reflection faces, 4096 SH rays, 256 reflection samples
and a configurable output budget (64 MiB by default). Baking resolutions below
four are raised to the historical native baker's four-texel minimum; validated
prebaked snapshots can retain one- or two-texel faces.
Memory reports retain `probeCount` and add `irradianceProbeCount`,
`reflectionProbeCount`, `irradiancePositionBytes` and `reflectionPositionBytes`.
`positionBytes` counts the owned placement fields, counting a legacy shared
field once. GPU bytes include packed coefficient, placement and reflection data.
Runtime admission also checks the device
storage binding limit and the runtime memory ledger.

Scatter is present in display, screenshots, worker rendering and offline
HDR/AOV capture. IDs start at 0x100000 and remain stable per original instance;
an HLOD draw uses its first member's ID. Transparent scatter selects RGBA16Float
for the offline beauty attachment so core WebGPU alpha blending works; resolved
HDR arrays remain float32. Opaque captures keep the existing RGBA32Float target.

## Verification

`scripts/generate-w09-fixtures.py` executes historical `bf8db93` Python and
Rust code independently of the web implementation. Fixtures include filtered
and resampled-mask placement, QEM geometry, 3D HLOD geometry/activation, LOD
selection, wind uniforms, flat/ridge SH, and asymmetric off-center cubemaps with
directional lighting and rotated environments. The shader oracle executes the
historical WGSL and current port on the GPU for wind, contact and blend.

The accepted tolerances remain transform max error `1e-5`, SH max error `1e-3`
and reflection SSIM `0.98`. Wrong-direction and swapped-face controls fail.
GPU SH comparisons cover 22,528 flat and 24,576 ridge pixels and three ridge
normals. Reflection sampling covers six faces, three roughness values and
18,432 covered pixels. Source/dist, worker frame/time, static HLOD pixels,
64-probe stress, edge/outside weights, rejection retention, clear, cancellation,
capture and recovery are checked. Probe-free shared shader text resolves
byte-identically to W08, and independently rebuilt W08 display/HDR frames match.

Fixed seed/time display, HDR and ID hashes are pinned in
`tests/golden/w09/hashes-chromium-preflight-rtx3070-win.json`, with adapter,
driver, OS and browser metadata. On that exact preflight profile run:

```powershell
$env:FORGE3D_WEBGPU_REQUIRED = "1"
$env:FORGE3D_W09_COMPARE_W08 = "1"
$env:FORGE3D_W09_PINNED_HASH_PROFILE = "chromium-preflight-rtx3070-win"
npm run test:browser -- tests/playwright/w09_scatter_probes.spec.ts
```

The W08 comparison requires a clean build of commit
`2dc0b9e1b343095233dea1bd73edc64578547009` copied to ignored `pkg/w08-base`.
Every WASM build is compared in a fresh Window realm.

`scatter-probes-v1` retains its 16 MiB GPU / 64 MiB CPU budgets and 60-second
reference-hardware run. Windows RTX 3070 results are **Chromium preflight**.
They do not qualify `reference-discrete`, which requires Ubuntu/Vulkan on
`FW-LNX-NV-01`. The integrated budget is **blocked on INF-00**: pinned
`FW-WIN-I12-01` (`forge3d-web` + `hw-win-intel12`) is in maintenance and
unprovisioned. Substituting another integrated adapter is not permitted; a
qualifying run must attest that machine's exact adapter, driver and OS.

`npm run test:package-consumer:w09` remains the clean-commit tarball gate.
A local installed-tarball check of this dirty review snapshot is supplemental
Chromium preflight evidence; it does not replace that gate. No commit, publish
or physical-browser qualification is implied. See [review evidence](w09-review-evidence.md)
for observed checks, measured values, and remaining blockers.

The package entrypoint exposes the population/LOD constructors, wind settings,
probe class, capture-material defaults and their types. Probe packing, grid
normalization, SH/cube basis and scatter selection/accounting helpers are
implementation details and are no longer root exports.

`Forge3DWorkerRenderer.setCamera(camera)` returns a promise. Await it before
rendering; it copies the input to the worker session and retains it for recovery.
