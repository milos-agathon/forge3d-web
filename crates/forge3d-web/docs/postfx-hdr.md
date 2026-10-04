# Ordered HDR and post-FX (W11)

Import from `@forge3d/web`. Runtime, session and viewer expose `setPostFx`,
`getPostFxReport`, `resetPostFxHistory` and `readPostFxIntermediate`. Scene
`setPostFx` retains an owned snapshot for commits, worker replay and recovery;
`getPostFx` returns a copy.

```ts
import { PostFxChain, createIdentityColorLut } from "@forge3d/web";
const chain = new PostFxChain([
  { kind: "ssao", id: "ao", radius: 0.5 },
  { kind: "ssgi", id: "gi" },
  { kind: "ssr", id: "reflections" },
  { kind: "bloom", id: "glow", quality: "high" },
  { kind: "dof", id: "focus", focusDistance: 10, tiltPitch: 0.1 },
  { kind: "motion-blur", shutter: 0.5 },
  { kind: "denoise", iterations: 3 },
  { kind: "taa" },
  { kind: "tonemap", operator: "aces", exposure: 0,
    lut: createIdentityColorLut(16) },
  { kind: "lens", vignetteStrength: 0.25 },
]);
viewer.setPostFx(chain);
chain.setEnabled("glow", false);
viewer.setPostFx(chain);
const hdr = await viewer.readPostFxIntermediate("color");
const ao = await viewer.readPostFxIntermediate("ao:temporal");
console.log(viewer.getPostFxReport().passOrder, hdr.data, ao.data);
```

## Ordering and color

The graph preserves supplied order. HDR effects precede the single enabled
tonemap; lens is last. Omitted tonemap inserts a `display` resolve before lens.
At most 16 input effects and one AA history are allowed. IDs are unique ASCII
letters, digits, underscores or hyphens, up to 64 characters. Unknown fields,
invalid order, non-finite values and malformed snapshots reject with
`INVALID_INPUT`. `null`, an empty chain, or all effects disabled releases
resources and restores the original rendering path.

Color remains linear HDR through `rgba16float` stage textures. Tonemap supports
`none`, `reinhard`, `reinhard-extended`, `aces`, `uncharted2`, `exposure` and
`display`. Exposure is in stops (1 doubles radiance); white point defaults to 4.
Gamma 0 uses sRGB; a positive gamma replaces that transfer. LUTs contain
`size^3` linear RGB triples in [0, 1], red varying fastest, with sizes 2–64.
They run after tonemap, before output encoding. Lens matches the native display
space formula, then returns to linear storage; final output applies the transfer
once. Display overlays render after that transfer.

## Effects and defaults

| Kind | Settings and behavior |
|---|---|
| `ssao`, `gtao` | Radius 0.5, bias 0.025, intensity 1.5, 16 samples; depth/normal/ID bilateral filtering and temporal reprojection. |
| `ssgi` | HZB diffuse tracing, distance 1, intensity 0.5, 16 steps, one hemisphere sample; irradiance IBL fallback. |
| `ssr` | Thickness 0.1, distance 32, intensity 5, 96 steps; roughness/BRDF weighting and specular IBL fallback. Miss records have zero composite weight to avoid duplicate scene IBL. |
| `bloom` | Threshold 1.5, softness 0.5, strength 0.3, radius 1. Low/medium use one native separable blur pair; high/ultra use two/three at octave radii. |
| `dof` | Native CoC, aperture 0.1, focus 10, focal length 50, sensor 36. Low/medium use Poisson kernels; high/ultra use hexagonal rings. Tilt pitch/yaw and bokeh rotation are supported. |
| `motion-blur` | Depth-aware velocity sampling, shutter fraction 0.5, 16 samples, capped at 64 pixels. Camera, scene-object transforms and scatter wind contribute motion. |
| `taa` | Halton jitter, YCoCg variance/neighborhood clamp, weight 0.9, gamma 1.25, motion scale 100; ID and previous-depth rejection (threshold 0.01). |
| `accumulation-aa` | 64 jittered samples by default, running average and frozen output after the requested 1–4096 samples. Motion restarts accumulation. Mutually exclusive with TAA. |
| `denoise` | Native 5×5 A-trous kernel at steps 1/2/4 by default; RGB/depth weights plus normal, albedo and ID edge guides. |
| `lens` | Brown–Conrady radial distortion, chromatic aberration and vignette; all strengths default to zero. |

Screen-space effects cannot recover offscreen or occluded radiance. IBL, or
explicit linear RGB `fallback` when IBL is disabled, fills misses. Browser ray
projection uses web camera/depth conventions and conservative HZB tests with
binary crossing refinement. This is a portable equivalent of the historical
native tracer; the native fallback shaders are independently tested. Realtime
velocity blur differs from the historical terrain multi-frame shutter
accumulator. W06 offline `renderFrames` retains temporal shutter sampling.

## History, readback and formats

Settings, scene/material/light/environment changes, resize, camera cuts and
explicit reset invalidate histories. Recovery replays settings with fresh
history. Ordinary camera motion reprojects; object identity/depth changes reject
stale samples. Jitter is excluded from velocities and AA resolves onto stable
pixel coordinates. Screenshots/intermediate reads reuse the current frame
without advancing valid history. Concurrent readbacks are serialized.

Reports expose actual stage order, bytes, dimensions, formats, history
frames/reason and jitter. G-buffer primary color is `rgba32float` for opaque
rendering and `rgba16float` for blending, avoiding optional float32 blending.
Albedo/normal use `rgba32float`, normalized linear depth/HZB `r32float`, IDs
`r32uint`, and pixel velocity `rg32float`. Each geometry pass fits the default
32-byte color-attachment budget. Compute uses 14 sampled textures and manual
bilinear `textureLoad`; optional float32 filtering and shader-f16 are unnecessary.
Final output selects hardware sRGB transfer or explicit encoding for the surface.

Debug views are `color`, `depth`, `normal`, `albedo`, `motion`, `hzb` and `effect`:

```ts
viewer.setPostFx({ effects: chain.toJSON().effects ?? [],
  debug: { view: "effect", effectId: "ao" } });
```

Intermediate names include `color`, `depth`, `normal`, `albedo`, `motion`,
`hzb:<mip>` and exact report stage names. An effect ID selects its last stage.
Readback returns width, height, channels and an owned `Float32Array`.
Allocations are admitted atomically before creation. Rejected edits keep the
previous graph, pixels and memory report. Disabling returns allocations to
baseline; resize and blending transitions account for the replacement graph.

## Verification

`npm run test:w11` covers independent toggles, nonblank HDR, native shader SSIM
≥0.98 with failing negative controls, debug views, order, output transfer, HZB
mips, camera/object/wind motion, ≥95% disocclusion error decay within eight
frames, converged flicker ≤1/255, accumulation, recovery, worker replay,
allocation rejection and 30 disposal cycles. `npm run test:package-consumer:w11`
executes the probes through an installed tarball with W03–W10 regression probes.

Sources and hashes are pinned in `tests/golden/w11/provenance.json`.
`python scripts/generate-w11-native-fixtures.py --check` verifies them against
commit `bf8db93233e5158f6d226991fc5d230832c2d806`. The oracle uses a separate
WebGPU device and historical sources, with documented format/validation
adaptations. High-quality DoF is the lowest observed SSIM (0.9920); TAA and
denoise exceed 0.9999. Implementation acceptance does not replace the separately
managed physical-browser release gates.

The SSR reference adapter supplies projection focal scales to the historical
`inv_proj_matrix` entries that its fallback shader divides by. It also maps the
web G-buffer's perceptual roughness to the native shader's linear mip fraction
by squaring it, and uses linear mip filtering on both devices. These adaptations
make the reflection rays and fractional source LOD agree; leaving normal alpha
at zero compared mip zero against the renderer's roughness-dependent sample.
The shader sources, SSIM threshold and failing negative controls remain pinned.
SSR additionally uses a supplied directional cube with distinct HDR mip values,
so the comparison exercises ray direction and fractional LOD independently of
IBL convolution. A zero-roughness reference must fail SSIM 0.98, reproducing the
former missing-alpha input bug. The native SSR reference uses nearest spatial
taps and linear mip interpolation: on SwiftShader its linear cube-edge taps
lost radiance (SSIM 0.957), while the renderer matched the cube's known formula
at SSIM 0.999997. The smooth directional cube bounds the spatial sampling
difference. Both native and runtime images must additionally meet SSIM 0.98
against independently reconstructed analytic world-reflection radiance. The
probe requires over 1,000 covered pixels and zero hit alpha on every covered
pixel, so it proves the intended environment-only case. The renderer retains
linear spatial and mip filtering, and the 17 historical shader hashes remain
unchanged. The W07 exact device-loss replay probe prepares
IBL once and reuploads those same texels after recovery; W04/W10 retain coverage
of live convolution, native image parity and IBL cache/recovery behavior.
