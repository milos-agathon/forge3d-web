# Environment, atmosphere, clouds and water

`Forge3DEnvironment` owns a serializable configuration. Pass it to
`scene.setEnvironment`, `runtime.setEnvironment`, `session.setEnvironment`, or
`viewer.setEnvironment`. Passing `null` releases the environment GPU resources.
The default has no sky, fog, clouds, volumes or water.

```ts
import { Forge3DEnvironment, generateDensityVolume, sunPosition } from "@forge3d/web";

const haze = await generateDensityVolume({
  preset: "localized_haze", bounds: [-20, 0, -20, 20, 12, 20],
  dimensions: [32, 24, 32], densityScale: 4, seed: 13,
});
const environment = new Forge3DEnvironment({
  sun: { latitude: 51.5, longitude: 0, utc: "2024-06-21T06:00:00Z", timeScale: 3600 },
  sky: { model: "hosek-wilkie", turbidity: 2 },
  fog: { mode: "height", density: 0.01, falloff: 0.03, godRays: true },
  clouds: { mode: "hybrid", preset: "gentle", height: 40, thickness: 20, seed: 13 },
  volumes: [haze],
  water: [{ bounds: [-25, -25, 25, 25], height: 3, reflection: "planar", foamWidth: 2 }],
  quality: "high", temporalWeight: 0.8,
});
scene.setEnvironment(environment);
scene.setTimeSeconds(6); // Six hours after the epoch at this timeScale.
session.setScene(scene);
const position = sunPosition(51.5, 0, "2024-06-21T12:00:00Z");
```

Coordinates use Y up, east -X and north -Z. `sunPosition` accepts UTC calendar
strings with an optional `Z`, returning azimuth/elevation in degrees and a
normalized direction toward the sun. Latitude/longitude are clamped as in the
native NOAA implementation. Explicit timezone offsets and invalid dates are
rejected. The first directional light follows the sun, color and intensity;
its direct intensity becomes zero below the horizon. Clearing a runtime
environment restores the previous lighting. Clocks survive copies, JSON
snapshots, workers and viewer recovery.

## Atmosphere and density volumes

Preetham and the native analytic Hosek-Wilkie approximation share a depth
composition pass for terrain and general geometry. Fog modes are `uniform`,
`height` (falloff above a base height) and `exponential`. Scattering and
absorption control extinction; HG anisotropy is bounded to -0.95..0.95.
`godRays` samples configured cascaded shadow maps, with screen depth occlusion
when shadow maps are disabled.

`volumetricMode: "froxel"` caches fog density and sun illumination in a
ceil(width/8) x ceil(height/8) x steps grid; `raymarch` evaluates these along
pixel rays. Bounded density boxes and clouds retain clipped ray marching in
both modes. `resolutionScale` is 1 or 0.5, with depth bilateral upscaling.
Temporal history is reprojected with depth rejection and invalidated on
camera, time, configuration, resize and recovery changes. Its default weight
is zero for reproducible capture.

Density bounds are `[minX,minY,minZ,maxX,maxY,maxZ]`. Samples use X-fastest
layout, values 0..1 and owned copies. Limits are eight boxes and 2,097,152 total
samples. `generateDensityVolume` ports native TV6 `valley_fog`, `plume` and
`localized_haze` with deterministic seeded noise. Resolution axes are 2..96.
Optional terrain supplies bilinear, domain-adjusted, exaggerated ground
heights. Generation yields between slices, accepts `{signal,onProgress}`,
and returns no partial field on cancellation.

## Clouds and water

Cloud modes are `billboard` (one slab sample), `volumetric` and `hybrid`
(volumetric nearby, billboard at distance). Wind presets are `static`,
`gentle`, `moderate` and `stormy`; explicit XZ wind overrides their speed.
Coverage, density, thickness, scale, seed, color, scatter strength, absorption
and ambient light are independent controls. Native cloud scattering uses the
scene IBL. Projected cloud density casts terrain and general geometry shadows.

Water bounds are `[minX,minZ,maxX,maxZ]`. Explicit masks use X-fastest values
0..1 and `maskDimensions`. Automatic DEM water detection remains removed.
Water has depth color, the three native wave terms, upward wave normals,
Fresnel/specular light and shoreline foam. Reflection tiers are analytic
`sky`, depth-tested `screen`, and `planar`. Planar layers render mirrored
terrain/scene/scatter with clipping below the plane. Four layers are supported.
Debug views are `water-mask`, `foam`, `reflection`, `clouds` and `transmittance`.

Offline HDR captures include atmosphere and water. Water surface depth,
normal, albedo, ID and camera motion replace the underlying terrain guides.
Layer i writes `AOV_ID_WATER_BASE + i` (base 0xfffffff0). Atmosphere retains
geometry guides and overlays compose last. Screen reflections cannot recover
offscreen geometry; planar reflections use the existing scene LOD selection
and omit recursive atmosphere/water composition.

## Resource admission and verification

`environment.memoryReport(width,height)` predicts allocation;
`getEnvironmentMemoryReport()` reports committed resolution, steps, bytes,
counts and history state. The runtime admits all textures, histories,
uniforms, voxel/mask storage, froxels and reflection layers in one ledger
transaction before allocation. Budget rejection retains the old frame.
`overflowPolicy: "downscale"` can halve a new full-resolution request and its
steps (minimum eight). Resize rejects sizes exceeding the budget. Capture
scratch buffers use the offline ledger. Composition fits the WebGPU minimum
of 16 sampled textures without adding terrain shader bindings.

Run `npm run test:w10` after rebuilding WASM/TS/dist. Native sun/density truth
is regenerated by `scripts/generate-w10-native-fixtures.py` from pinned Git
sources and independent Rust executables. GPU probes compare native sky,
cloud scattering and water wave arithmetic with max error <1e-3 and SSIM
>=0.98, including negative controls. Full-frame cloud/water/sky images are
browser compositor regression goldens, distinct from the native probes.
`npm run test:package-consumer:w10` installs a packed package in a clean
consumer and runs environment, offline, worker, recovery and golden checks
alongside the existing W03-W09 package checks.

See [W10 verification](w10-verification.md) for the clean-commit installed
package observations and qualification limits.
