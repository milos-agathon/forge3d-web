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
`gridScatterTransforms` also accepts a density `mask` matching the heightmap,
`densityScale`, slope/elevation filters, edge margin and minimum distance.
Impossible requested populations throw `INVALID_INPUT`.

LOD thresholds increase strictly; only the last level may omit a threshold.
HLOD cells merge the coarsest geometry. A cluster activates beyond its bounding
sphere and only when all members remain inside the draw distance. Original
instances then stop drawing. Bounds contain all LODs and maximum wind offsets.
QEM uses deterministic quadric-cost edge collapses and recomputed normals;
the CPU work limit is 4096 triangles per simplification. Larger sources throw
`RESOURCE_LIMIT_EXCEEDED`; prepare a smaller scatter asset first.

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

Baking yields between probes and accepts an AbortSignal. Limits are 256 probes,
64x64 reflection faces, 4096 SH rays, 256 reflection samples and a configurable
output budget (64 MiB by default). Memory reports separate buffer bytes, fallback texture bytes and total GPU bytes.
Runtime admission also checks the device
storage binding limit and the runtime memory ledger.

Scatter is present in display, screenshots, worker rendering and offline
HDR/AOV capture. IDs start at 0x100000 and remain stable per original instance;
an HLOD draw uses its first member's ID. Transparent scatter selects RGBA16Float
for the offline beauty attachment so core WebGPU alpha blending works; resolved
HDR arrays remain float32. Opaque captures keep the existing RGBA32Float target.

## Verification

`scripts/generate-w09-fixtures.py` executes historical Python and Rust source
directly in an independent oracle. Transform fixtures use NumPy PCG64; probe
fixtures cover flat terrain and an occluding ridge. Unit and browser tests
check transform max error <=1e-5, containing bounds, repeat hashes, wind no-ops,
LOD/HLOD activation, SH max error <=1e-3 and reflection SSIM >=0.98. A deliberately
wrong cubemap must fail the SSIM threshold. Browser tests also check nonempty
scatter IDs, source/dist parity, scene/worker capture and recovery.

The `scatter-probes-v1` manifest admits 16 MiB GPU / 64 MiB CPU for the
192x128 acceptance scene. GPU allocation, rejection and release are tested;
the manifest's longer reference-hardware performance run remains a separate
lab contract. The native SH debug comparison uses 512 covered interior pixels,
and the roughness/box-projection reflection comparison uses 1024 covered pixels.

`npm run test:package-consumer:w09` rebuilds a clean HEAD, installs its tarball
in a separate consumer, runs API/package/documentation checks and browser
acceptance (including W09 worker rendering and native parity). Evidence records
`gateScope: "w09-package-acceptance"`. The default `test:package-consumer`
continues to require the full release infrastructure suite. On Windows, its
POSIX runner tests need Bash and file-symlink privileges.

To reproduce the W08 byte comparison, rebuild clean commit
`2dc0b9e1b343095233dea1bd73edc64578547009`, copy its `dist` directory to this
package's ignored `pkg/w08-base` directory, and run the W09 browser spec with
`FORGE3D_W09_COMPARE_W08=1`. Each WASM build runs in a fresh Window realm.
