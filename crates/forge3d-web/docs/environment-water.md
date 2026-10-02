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

Sky controls include `aerialPerspective` (default true), `aerialDensity`
(default 1) and sky-level `sunIntensity` (default 1), separate from the
directional light intensity. Turbidity, ground albedo, sun size, sky intensity,
exposure and aerial density affect covered terrain pixels. Setting density to
zero or disabling aerial perspective removes this contribution. Screen terrain
uses the native aerial formula before tonemapping; perspective terrain and
general geometry use the shared depth compositor. Fog in-scatter samples the
sky when enabled, otherwise the configured fog color. `sunSize` is the native
scale (default 1), not an angular radius.

Preetham and the native analytic Hosek-Wilkie approximation share a depth
composition pass for terrain and general geometry. Fog modes are `uniform`,
`height` (falloff above a base height) and `exponential`. Scattering and
absorption control extinction; HG anisotropy accepts the native -1..1 range.
Fog defaults match native: uniform, anisotropy 0, god rays off and falloff 0.1.
`shaftIntensity` defaults to 1, `shaftSamples` to 32 (8..128), and `useShadows`
to true. `useShadows: false` bypasses occlusion for scattered shafts.
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

Clouds expose `renderPath: "world" | "native"`. The default world path preserves
depth-clipped clouds and projected terrain shadows: billboard is one slab
sample, volumetric ray-marches, and hybrid selects the distant slab sample.
The native path reproduces the public native renderer's indexed clip-space
quad and billboard/volumetric/hybrid density modulation. The pinned native
vertex shader uses clip-space XY directly; it does not transform instances
into world-facing billboards. The web native path evaluates the quantized R8
noise/shape texels analytically and uses the native default IBL tint. Its fixed
noise ignores `seed`, and it has no world occlusion, height placement or cloud
shadows, matching that native pass. Use the world path for seeded clouds and
scene IBL lighting.

Presets static/gentle/moderate/stormy set wind strength 0/0.2/0.5/1.2 and
`animationSpeed` 0/0.3/0.8/2. Explicit XZ wind overrides strength/direction;
animation speed multiplies elapsed time independently. Density, coverage,
scale, color, scatter strength, absorption and ambient remain independent.

Water bounds are `[minX,minZ,maxX,maxZ]`. Explicit masks use X-fastest values
0..1 and `maskDimensions`. Automatic DEM water detection remains removed.
Water has depth color, the three native wave terms, upward wave normals,
Fresnel/specular light and shoreline foam. Reflection tiers are analytic
`sky`, depth-tested `screen`, and `planar`. Planar layers render mirrored
terrain/scene/scatter with clipping below the plane. Four layers are supported.
Water controls also include `fresnelPower`, `hueShift` (radians), `tintColor`,
`tintStrength`, `rippleScale`, `rippleSpeed`, `refractionStrength`,
`shoreAttenuationWidth` (world units), `waveDistortionStrength` and
`foamNoiseScale` (default 20). Mode defaults to native transparent; shore width
defaults to 0.3 and distortion strength to 0.02. Modes are
`disabled`, `transparent`, `reflective` and `animated`; only animated mode
displaces the surface, and transparent suppresses reflection blending.

`TerrainMaterialInput.waterMask` independently ports native masked terrain
water, with nearest sampling, native depth color, directional wave normals,
IOR 1.33 Fresnel and GGX sun/IBL. It uses the auxiliary texture alpha channel
and reports `water` in `maskChannels`. Mask data is owned Uint8 coverage or
shore-distance values, 0..255; dimensions match the terrain UV convention.

Deliberate water divergences preserve the existing explicit-layer appearance:
tint/ripples/refraction default to zero (native 0.2/1/0.3). Existing web alpha 0.8, wave amplitude/frequency/speed
0.05/3/0.5, reflection strength 0.6 and foam remain unchanged; native surface
defaults are 0.7, 0.1/2/1, 0.8 and foam off. Explicit plane foam/refraction use
world depth and screen samples rather than native pixel-width foam and its
procedural refraction tint. Masked terrain reflections use a water layer with `terrainMask: true` and
`reflection: "planar"`. This layer supplies a mirrored scene texture to the
terrain material; it creates no explicit water plane or water AOV overlay.
One such layer is supported alongside explicit layers. Its height uses Y for
perspective terrain and native Z for screen terrain. Fresnel, strength, shore
width and distortion control the native material blend. `mode: "disabled"`
disables its reflection contribution; use `mode: "reflective"` when authoring.
The masked profile needs 15 sampled textures, or 20 with scene material-0
textures; unsupported commits are rejected before allocation. Native binary
masks can have zero fallback depth and suppress reflections through shore
attenuation. The committed shore-distance-mask oracle avoids that degeneracy
and checks both reflection contribution and unchanged land pixels.

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
scratch buffers use the offline ledger. The untextured profiles fit the WebGPU minimum of 16 sampled textures.
Terrain aerial and masked-water code are optional shader variants. The original
terrain material uniform size is preserved; aerial reuses the existing 512-byte
environment uniform, extended by 96 bytes only for a masked reflection layer.
With no W10 input, the terrain shader omits both code paths and their bindings.

Run `npm run test:w10` after rebuilding WASM/TS/dist. Native sun/density truth
is regenerated by `scripts/generate-w10-native-fixtures.py` from pinned Git
sources and independent Rust executables. GPU probes compare native sky,
cloud scattering and water wave arithmetic with max error <1e-3 and SSIM
>=0.98, including negative controls. Full-frame cloud/water/sky images are
browser compositor regression goldens, distinct from the native probes.
`tests/playwright/w10_native.spec.ts` additionally compares actual web renders
against installed-native atmosphere, masked-water and cloud scenes at SSIM
>=0.98, including the applicable historical terrain PNGs. The native fixture
manifest records source commits, native versions, binary hashes and image
hashes. See the regeneration instructions in the verification document.
`npm run test:package-consumer:w10` installs a packed package in a clean
consumer and runs environment, offline, worker, recovery and golden checks
alongside the existing W03-W09 package checks.

See [W10 verification](w10-verification.md) for the clean-commit installed
package observations and qualification limits.
