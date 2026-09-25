# Forge3D Browser WebGPU/WASM Functional-Parity Plan

Revised: 2026-09-20

Status: authoritative parity roadmap; supersedes the former browser-MVP scope in
this file. The package remains browser/npm/WASM-only as a delivery format, but
native Forge3D functionality is no longer out of scope. Every native capability
must be implemented directly, represented by an explicitly tested browser
equivalent, or recorded as a retired upstream API that is absent from the
parity baseline.

## Goal

Deliver `@forge3d/web` with 100% functional parity against the last complete
Forge3D native/Python tree while preserving a browser-native public API and
execution model. Parity is capability parity, not Python syntax, a PyO3 ABI,
desktop windows, or filesystem-path parity.

The parity baseline has explicit layers. Commit
`a55911f021925a3264e476374ce43d1b204f1073`, the immediate parent of the native
deletion, is normative for the final public contract: 220 effective package-
root exports (207 literal `__all__` entries plus 13 non-duplicated dynamically
extended bundle exports), 28 registered native classes and 44 registered native
functions. It is not a
complete implementation baseline. Relative to
`1f4084af428dc699bdcd108b029736cb73903926`, it deletes 14 active core files
(2,658 lines) while replacing 24 Phase-15 dummy bindings with compatibility-
grade observable shims. Several shims are intentionally weaker than historical
Forge3D—examples include cube-returning glTF import, constant tangents, index-
truncating simplification and gradient hybrid rendering—so their existence is
contract evidence, not the quality target.

Commit `bf8db93233e5158f6d226991fc5d230832c2d806`, the parent-side state before
the browser-migration audit began, is the deepest last monolithic native-engine
snapshot: its root Cargo package compiles the full renderer, path tracer, SDF,
viewer and Python/native tree. `0cec80d` is the last 1.26 release snapshot
before the final pre-migration changes. `1f4084a` is a post-split compatibility
reconciliation: it preserves much of the monolithic source and names the Phase-
15 restoration surface, but its split core exposes only a browser-safe subset
and therefore is not by itself proof of deep semantics. Earlier release commits
remain authoritative for behavior removed before `bf8db93`.

The composite rule is: use `bf8db93` plus earlier release tests for the deepest
shipped behavior; use `1f4084a` and `a55911f` to prevent symbol, signature and
diagnostic loss; use current `HEAD` for browser-only behavior; and never let a
staging deletion, no-op or weak compatibility shim lower the functional target.

At `1f4084a` the tree contains 72 Python API files, 2,162 Rust/WGSL files
because the 1,071-file pre-split `src/` tree coexists with migration copies,
211 root test files including 191 `tests/test_*.py` files and 1,792 test
definitions, 54 example assets/scripts, and 88 documentation assets including
53 Markdown/RST pages. Commit `86daa089bcf8a13b1c67342e32cd8cfcae0a2f53`
then removes 2,666 files; that deletion is scope-removal evidence, not evidence
that those capabilities never existed. Current `HEAD` is the fourth layer: it
defines browser-only features and lifecycle guarantees that parity work must
retain even when native Forge3D had no direct analogue.

## Audit Method And Sources

The inventory reconciles all six required evidence classes:

1. Public contracts: `a55911f:python/forge3d/__init__.py:456-688`, its stubs,
   every public definition under `python/forge3d/**`, PyO3 registrations under
   `src/py_module/**`, and the final semantic-restoration bindings in
   `a55911f:crates/forge3d-python/src/lib.rs`.
2. Implementation: compiled monolithic source at `bf8db93:src/**`, release
   source at `0cec80d:src/**`, and post-split compatibility source at
   `1f4084a:crates/**`. Compact `1f4084a:src/**` citations below identify the
   retained path; W00 records its content hash and the corresponding
   `bf8db93`/earlier implementation commit. Where behavior differs, the deepest
   tested pre-migration implementation wins.
3. Documentation: `1f4084a:docs/guides/feature_map.md`,
   `1f4084a:docs/api/api_reference.rst`,
   `1f4084a:docs/start/architecture.md`, the support matrices, tutorials, and
   gallery pages.
4. Changelog: `1f4084a:CHANGELOG.md:7-1929`, covering releases 0.0.2 through
   1.26.0 and explicit removals in 1.13.0.
5. Behavior evidence: all 191 final native tests and 54 final examples, plus
   historical release tests when a subsystem was shipped and later removed.
6. Git history: release milestones, monolithic boundary `bf8db93`, migration
   commits `438d9da` through `a55911f`, deletion commit `86daa08`, and later
   browser work including `b271b5d`, `9df7581`, `ffba491`, `3249510`,
   `bc57675`, `8d93b98`, `acde4c8`, `09a05dd`, `4421f61`, and `34b4d36`.

Evidence grades used by the parity manifest are: `A` runtime/output behavior;
`B` parser/config/API behavior; `C` source/symbol presence; and `D`
documentation/changelog/history claim. A row cannot be marked complete from
grade C or D alone. Lifecycle values are `final-public`, `final-internal`,
`diagnostic-only`, `historically-shipped-then-removed`, and
`intended-unverified`. FP, FI and the split DA obligations are the functional-
parity denominator; DA closes only as a tested exact contract. The final two
remain tracked tombstones outside the denominator.

Current web evidence is the checked-in package, particularly
`crates/forge3d-web/types/index.d.ts:5-286`,
`crates/forge3d-web/src/runtime/mod.rs:25-47`,
`crates/forge3d-web/src-ts/viewer.ts`, and the browser tests. The current
runtime owns one optional terrain plus one camera and can issue one terrain
draw; it is not yet a general scene engine. The inactive-root list at
`crates/forge3d-core/src/feature_gates.rs:18-59` independently confirms the
missing surface. The checked-in browser contract has 26 exported declarations
(19 interfaces, four aliases and three classes), 12 unit files with 80 `it`
cases, 14 Playwright specs with 38 literal `test(...)` declarations (39
generated cases, because one declaration expands over `Blob` and `File`), six API-contract artifacts
and seven HTML fixtures. W00 freezes these counts and identities so parity work
cannot regress browser-only lifecycle behavior while adding native outcomes.

## Parity Accounting Rules

- `Implemented` means the stable web API, runtime behavior, tests, docs, and a
  package-consumer example all exist.
- `Partial` means some behavior exists but does not meet the native contract.
- `Gap` means the capability has no browser implementation or equivalent.
- `Equivalent` means the native mechanism is impossible or inappropriate in a
  sandboxed browser and the named browser design is the required parity target.
- `Contract-only` means native Forge3D intentionally reported a diagnostic,
  experimental, Pro-gated, or unsupported state rather than rendering it. Web
  parity must return the same truthful structured result unless this plan
  explicitly requires full implementation.
- A matrix row cannot disappear. Renames update the manifest and this plan in
  the same change. `Excluded`, unowned backlog, and unspecified work states are
  invalid.
- A feature is complete only when its public API, implementation, unit tests,
  browser tests, package tests, documentation, example, resource accounting,
  device-loss behavior, and disposal behavior all pass.
- The capability numerator counts an `I` FP/FI row only with grade-A or
  grade-B web evidence and counts a `C` DA row only when its diagnostic behavior
  and limits are tested. The denominator is the 84 capability rows. Tombstones
  and XC constraints are not in that denominator; all seven XC constraints are
  mandatory independent release gates.

## Current Browser Baseline

The current package already implements:

- async secure-context WebGPU initialization, canvas presentation, stable
  errors, device/surface recovery, and deterministic disposal
  (`crates/forge3d-web/src/runtime/init.rs:18-109`,
  `runtime/render.rs:85-257`);
- dense Float32 heightmaps, custom 2-8 stop ramps, normalized grid geometry,
  edge skirts, a fixed relief shader, and depth testing
  (`crates/forge3d-core/src/terrain.rs:3-114`,
  `crates/forge3d-web/src/runtime/terrain.rs:157-822`);
- URL, `File`, `Blob`, and `ArrayBuffer` little-endian f32 sources with ranges,
  cancellation, progress, and resource limits
  (`crates/forge3d-web/src/io.rs:13-625`);
- low-level look-at camera plus high-level orbit controls, touch, pen, keyboard,
  DPR-aware resize, visibility/BFCache behavior, invalidation rendering, and
  one device-recovery attempt (`crates/forge3d-web/src-ts/**`);
- PNG screenshot to `Blob`, diagnostics, desktop/mobile allocation ceilings,
  ESM packaging, declarations, Playwright tests, and installed-tarball tests.

The old plan omitted the subsequently implemented `Forge3DViewer`; its public
surface is frozen at `crates/forge3d-web/types/index.d.ts:269-286`. The parity
work retains all current lifecycle and browser-evidence guarantees.

## Exhaustive Parity Matrix

Status abbreviations are machine-oriented closure states: `I` is implemented
and verified, `P` is partial and must close to `I`, `G` is absent and must close
to `I`, `E` is an unresolved browser-equivalent implementation and must close
to `I`, and `G→C` is an absent diagnostic contract that must close to verified
`C`. Lifecycle abbreviations are `FP` final-public, `FI` final-internal, `DA`
diagnostic-only active contract, and `XC` cross-cutting browser constraint.
Evidence is the strongest existing native grade. The task column points to one
ordered implementation owner.

There are 91 tracked rows: 84 capability rows and seven `XC` constraints. A
native symbol/workflow owns exactly one capability row; it may additionally
link to zero or more `XC` constraints. Constraints are deliberately many-to-
many and never claim duplicate native ownership. The parity percentage is
computed over the 84 capabilities; release is additionally gated on all seven
constraints reaching `I`.

### Runtime, GPU, And Platform Foundations

| ID | Life/evidence | Native capability and repository evidence | Current web comparison and required result | Status | Task |
|---|---|---|---|---|---|
| R01 | FP/A | GPU/device/session creation and categorized errors: `1f4084a:src/core/gpu.rs`, `src/core/session.rs`, `python/forge3d/_gpu.py:24-84` | Async WebGPU runtime and 18 stable codes exist; retain them and negotiate all later pass limits/features | I | W24 |
| R02 | FP/A | Canvas/offscreen render and readback: `1f4084a:python/forge3d/__init__.pyi:137-170`, `src/scene/render_paths/**` | PNG screenshot exists; generalize to typed color, depth, ID, float, HDR and AOV readback | I | W06 |
| R03 | FP/B | Device probes and adapter diagnostics: `1f4084a:python/forge3d/_gpu.py:24-84`, `tests/test_api_contracts.py` | Current capabilities are minimal; expose adapter info, limits/features, fallback state, formats, timestamps and effective quality | P | W02 |
| R04 | FP/B | Renderer/session/config/presets: `1f4084a:python/forge3d/__init__.pyi:116-156,447-476`, `python/forge3d/config.py:169-686`, `python/forge3d/presets.py:53-287` | Add `Forge3DScene`, typed renderer config, session capabilities, validation/copy and named presets | G | W02 |
| R05 | FI/A | Scene graph, matrix stack, framegraph/barriers and resource tracker: `1f4084a:src/core/scene_graph/**`, `src/core/framegraph_impl/**`, `src/core/resource_tracker.rs` | Replace one-terrain fixed pass with a scene graph and pass DAG; include native overlays, ground plane and text-mesh nodes | G | W02 |
| R06 | FI/A | Render bundles, GPU timing and scene stats: `1f4084a:src/core/render_bundles.rs`, `src/core/gpu_timing.rs`, `src/scene/stats.rs` | Add reusable bundles, timestamp metrics with CPU fallback and per-pass stats | G | W02 |
| R07 | FP/A | Memory tracker, 512 MiB policy, category reports and auto-downscale: `1f4084a:src/core/memory_tracker/**`, `src/render/memory_budget.rs`, `tests/test_p2_large_scene_memory.py` | Replace four coarse ceilings with allocation/category/peak tracking and deterministic quality downgrade | P | W02 |
| R08 | FI/A | Staging rings, buffers, fences, feedback, async readback/compute, tile cache, samplers/mipmaps and texture substrate: `1f4084a:src/core/staging_rings.rs`, `src/core/big_buffer.rs`, `src/core/double_buffer.rs`, `src/core/async_compute/**`, `src/core/tile_cache/**`, `src/core/texture_format.rs` | Add browser-safe rings, promise fences, bounded compute, cancellation/backpressure, format accounting and transcode fallbacks | G | W02 |
| R09 | FI/C | Native multithread pool: `1f4084a:src/core/multi_thread/**`, `src/core/async_compute/mod.rs` | Worker pool with transferable buffers, optional SAB path and deterministic single-worker fallback | E | W02 |
| R10 | FP/A | Desktop window/event loop and DPI input: `1f4084a:src/viewer/event_loop/**`, `python/forge3d/viewer.py`, `CHANGELOG.md` 1.2.0 | DOM viewer exists; add feature-equivalent worker `OffscreenCanvas` renderer with proxied input | P | W02 |
| R11 | FP/A | Native filesystem/headless offscreen renderer: `1f4084a:src/offscreen/**`, `python/forge3d/helpers/offscreen.py`, `tests/test_aov.py` | Hidden canvas/worker output as `ImageBitmap`, typed arrays, `Blob`, streams or OPFS handles | E | W02 |
| R12 | FP/B | Public API stability contracts: `1f4084a:tests/test_api_contracts.py`, `python/forge3d/__init__.py:456-684`; `a55911f` contract delta above | Machine-readable native-to-web symbol/workflow ledger rejects missing, duplicate and untested entries | I | W00 |

### Camera, Interaction, Animation, And Output

| ID | Life/evidence | Native capability and repository evidence | Current web comparison and required result | Status | Task |
|---|---|---|---|---|---|
| C01 | FP/A | Look-at, perspective, orthographic, view-projection and transforms: `1f4084a:src/py_module/functions/camera.rs:4-34`, `tests/test_perspective_projection.py` | Look-at perspective/orbit exist; add typed orthographic/projection/transforms and world/screen conversion | I | W05 |
| C02 | FP/B | Orbit and FPS cameras: `1f4084a:src/viewer/camera_controller.rs`, `src/viewer/input/viewer_input.rs`, `tests/test_viewer_ipc.py` | Add FPS/fly mode, controller switching, bindings and deterministic replay to existing orbit controls | I | W05 |
| C03 | FP/A | Target-aware camera keyframes/interpolation: `1f4084a:python/forge3d/__init__.pyi:595-649`, `tests/test_animation_mvp.py`, `examples/camera_animation_demo.py` | Add `CameraAnimation`, editing/evaluate/duration/frame-count API | I | W05 |
| C04 | FP/A | Terrain orbit/rail/follow rigs and clearance: `1f4084a:python/forge3d/camera_rigs.py:273-721`, `tests/test_camera_rigs.py`, `examples/terrain_camera_rigs_demo.py` | Add deterministic serializable rig builders using terrain sampler | I | W05 |
| C05 | FP/B | Snapshot and deterministic frame sequences: `1f4084a:python/forge3d/viewer.py:1113-1199`, `python/forge3d/helpers/frame_dump.py`, `tests/test_animation_mvp.py` | Extend single PNG to multi-frame progress/cancel streams and stable OPFS/download sinks | I | W06 |
| C06 | FI/B | Example-owned MP4/cinematic workflow through external ffmpeg: `1f4084a:CHANGELOG.md:500-511`, `tests/test_animation_mvp.py`, `examples/camera_animation_demo.py` | WebCodecs plus deterministic MP4 muxing; typed unavailable-codec diagnostic | I | W06 |
| C07 | FP/A | AOV, HDR, EXR and depth outputs: `1f4084a:python/forge3d/__init__.pyi:542-593`, `tests/test_aov.py`, `tests/test_exr_output.py` | Add color/albedo/normal/depth/ID/motion AOVs, float HDR and EXR `Blob` | I | W06 |
| C08 | FP/A | Offline accumulation, adaptive convergence and optional OIDN: `1f4084a:python/forge3d/offline.py:18-147`, `tests/test_tv12_offline_quality.py`, `tests/test_tv12_oidn.py` | Add WebGPU accumulation/variance controller and measurable AOV-guided WebGPU denoiser equivalent | I | W06 |

### Terrain And Large Raster Scenes

| ID | Life/evidence | Native capability and repository evidence | Current web comparison and required result | Status | Task |
|---|---|---|---|---|---|
| T01 | FP/A | DEM stats/normalization/domains/nodata/load: `1f4084a:python/forge3d/io.py:68-487`, `tests/test_dem_loading.py`, `tests/test_terrain_runtime.py` | Add async DEM model with stats, percentile/domain, nodata fill/mask, spacing and CRS metadata | I | W03 |
| T02 | FP/A | Grid mesh, R32F upload/readback and built-in/runtime colormaps: `1f4084a:src/terrain/mesh.rs`, `src/terrain/colormap_lut.rs`, `tests/test_terrain_renderer.py`, `CHANGELOG.md` 0.0.4-0.0.8 | Basic grid/height/ramp exist; add physical spacing, exaggeration/domain, readback and named LUTs | I | W03 |
| T03 | FP/A | Slope/aspect/contours and terrain queries: `1f4084a:src/terrain/analysis.rs`, `src/picking/terrain_query.rs`, `tests/test_terrain_analysis_api.py` | Add CPU/WASM and WebGPU compute analysis with consistent units and typed query results | I | W03 |
| T04 | FP/A | Heightfield AO and sun visibility: `1f4084a:src/terrain/renderer/height_ao/**`, `tests/test_heightfield_ao.py`, `tests/test_sun_visibility.py` | Add configurable compute passes and debug outputs | I | W03 |
| T05 | FP/A | Terrain PBR, triplanar, POM, sampling and clamps: `1f4084a:src/shaders/terrain_pbr_pom.wgsl`, `python/forge3d/terrain_pbr_pom.py`, `tests/test_terrain_viewer_pbr.py` | Replace fixed relief shader with typed PBR/POM pipeline and matching defaults/validation | I | W07 |
| T06 | FP/A | Material layers/noise/snow/rock/wetness/subsurface: `1f4084a:src/terrain/render_params/native_material.rs`, `tests/test_terrain_tv4_material_variation.py`, `tests/test_terrain_tv10_subsurface_materials.py` | Add masks, scalar/textured inputs, variation, SSS and deterministic fallback diagnostics | I | W07 |
| T07 | FP/B | Micro-detail and normal anti-aliasing: `1f4084a:src/terrain/render_params/native_material.rs`, `src/shaders/terrain_pbr_pom.wgsl`, `tests/test_terrain_materials.py` | Add detail normal/material modulation and specular AA quality tiers | I | W07 |
| T08 | FP/A | Clipmap rings, GPU LOD and geomorph seams: `1f4084a:src/terrain/clipmap/**`, `tests/test_clipmap_structure.py`, `tests/test_gpu_lod_selection.py`, `tests/test_geomorph_seams.py` | Replace whole-grid-only path with stable-budget crack-free camera-relative clipmaps | G | W08 |
| T09 | FI/C | Async tiled height/overlay IO, dedupe, cancellation, backpressure, coalescing and prefetch: `1f4084a:src/terrain/page_table/**`, `src/terrain/stream/**`, `CHANGELOG.md` 0.51-0.60 | Add priority range scheduler, cache, camera prefetch and telemetry | G | W08 |
| T10 | FP/A | COG ranges, IFD/overviews/tile stats: `1f4084a:python/forge3d/cog.py:37-346`, `tests/test_cog_streaming.py`, `examples/cog_streaming_demo.py` | Add GeoTIFF/COG worker, overview selection, cache, nodata/transform/CRS metadata | G | W08 |
| T11 | FP/A | Draped raster overlays, transforms, z-order and Normal/Multiply/Overlay blends: `1f4084a:src/terrain/page_table/overlay_loader.rs`, `tests/test_terrain_overlay_stack.py`, `examples/bosnia_terrain_landcover_viewer.py` | Add ordered lit/shadowed raster layers with opacity, extent and CRS transforms | G | W08 |
| T12 | FP/A | Draped vector overlays: `1f4084a:src/vector/layer.rs`, `tests/test_vector_overlay_drape.py`, `examples/luxembourg_rail_overlay.py` | Add terrain-aware point/line/polygon layers with depth bias and picking | G | W12 |
| T13 | FP/A | Scatter transforms/filters/masks, QEM LOD/HLOD, contact/blend and wind: `1f4084a:python/forge3d/terrain_scatter.py`, `tests/test_terrain_tv13_lod_pipeline.py`, `tests/test_terrain_tv21_blending.py`, `tests/test_tv22_scatter_wind.py` | Add deterministic generators, instancing, LOD/HLOD, contact/blend and time-driven wind | G | W09 |
| T14a | FP/A | Albedo virtual texturing: `1f4084a:src/core/virtual_texture/**`, `src/terrain/renderer/virtual_texture.rs`, `tests/test_tv20_virtual_texturing.py` | Add page table, feedback, residency, upload, cache and stats for albedo pages | G | W08 |
| T14b | DA/B | Normal/mask virtual-texture families are explicitly unsupported: `1f4084a:tests/test_tv20_virtual_texturing.py` | Return the same typed unsupported-family diagnostics; do not advertise residency | G→C | W08 |
| T15 | FP/A | SH L2 terrain irradiance and reflection probes: `1f4084a:src/terrain/probes/**`, `tests/test_terrain_probes.py`, `tests/test_terrain_reflection_probe_exports.py` | Add deterministic baker, runtime blending/debug and memory reports | G | W09 |
| T16 | FP/A | Water material/mask, waves, foam and planar reflections: `1f4084a:src/core/water_surface/**`, `src/terrain/renderer/water_reflection/**`, `tests/golden/terrain/terrain_water_reflection.png` | Add water layer with depth color, animation, Fresnel/specular, foam and reflection tiers | G | W10 |
| T17 | FP/A | Terrain atmosphere/aerial perspective: `1f4084a:src/terrain/renderer/atmosphere.rs`, `tests/test_terrain_sky_parity.py`, `examples/terrain_atmosphere_path_demo.py` | Share sky/volumetric system with depth-correct terrain composition | G | W10 |
| T18 | FP/A | Named variants/review layers: `1f4084a:python/forge3d/bundle.py`, `python/forge3d/viewer_ipc.py`, `tests/test_bundle_roundtrip.py` | Add atomic list/apply/query/visibility integrated with scene state and bundles | G | W19 |

### Lighting, Materials, Atmospherics, Transparency, And Post-Processing

| ID | Life/evidence | Native capability and repository evidence | Current web comparison and required result | Status | Task |
|---|---|---|---|---|---|
| P01 | FP/A | Directional/point/spot lights and presets: `1f4084a:src/lighting/light.rs`, `src/lighting/light_buffer/**`, `tests/test_light_feature_enablement.py`, `tests/test_lighting_preset.py` | Replace fixed shader lights with typed mutable collection, shadows and debug bounds | I | W04 |
| P02 | FP/A | Soft light radius/falloff presets: `1f4084a:src/core/soft_light_radius.rs`, `src/scene/py_api/soft_light.rs`, `tests/test_light_feature_enablement.py` | Add controls, effective range and point-affects-light query | I | W04 |
| P03 | FP/A | LTC rectangle lights: `1f4084a:src/core/ltc_area_lights.rs`, `src/lighting/area_lights.rs`, `src/scene/py_api/rect_area_lights.rs` | Add LUT, rect/two-sided lights and approximation controls | I | W04 |
| P04 | FP/A | BRDF/material routing, including alias/approximation routes: `1f4084a:src/shaders/brdf/**`, `src/render/params/shading.rs`, `tests/test_lighting_alignment.py` | Port the exact final enum and observable routing for Lambert, Phong/Blinn, Oren-Nayar, GGX/Beckmann, Disney, Ashikhmin, Ward, Toon, Minnaert, Subsurface and Hair; diagnose aliases/approximations | I | W04 |
| P05 | FP/A | PBR textures, TBN/normal maps, samplers/mipmaps, compressed/KTX2 textures and glTF MR channels: `1f4084a:src/mesh/tbn.rs`, `src/core/compressed_textures.rs`, `src/loaders/ktx2/**`, `src/io/gltf_read.rs`, `tests/test_mesh_tbn.py` | Add typed texture/material sets, color spaces, TBN, transcode and channel extraction | I | W04 |
| P06 | FP/B | IBL conversion, irradiance, specular prefilter, BRDF LUT and disk cache: `1f4084a:src/core/ibl/**`, `src/lighting/ibl_cache.rs`, `src/scene/py_api/ibl.rs` | Add WebGPU IBL and CacheStorage/OPFS cache keyed by source/settings | I | W04 |
| P07 | FP/A | Hard/PCF/PCSS/VSM/EVSM/MSM filters plus separate CSM pipeline: `1f4084a:src/lighting/shadow.rs`, `src/shadows/**`, `tests/test_shadow_techniques.py` | Add all filters/cascades; CSM must not be accepted as a filter enum | I | W04 |
| P08 | FP/A | Sun ephemeris/time-of-day: `1f4084a:src/lighting/ephemeris.rs`, `tests/test_sun_ephemeris.py`, `CHANGELOG.md` 1.9.4 | Add UTC/location sun position, synchronized directional sun and animation | G | W10 |
| P09 | FP/A | Preetham/Hosek sky, height fog, HG volumetrics/god rays/density volumes: `1f4084a:src/shaders/sky.wgsl`, `src/shaders/volumetric.wgsl`, `tests/test_volumetrics_sky.py`, `tests/test_fog_offline.py` | Add shared sky/atmosphere with temporal/froxel paths and bounded volumes | G | W10 |
| P10 | FP/B | Realtime clouds and cloud shadows: `1f4084a:src/core/clouds/**`, `src/core/cloud_shadows/**`, `src/scene/py_api/clouds.rs`, `tests/test_api_contracts.py` | Add billboard/volumetric/hybrid clouds, presets, wind/noise and terrain shadows | G | W10 |
| P11 | FP/A | G-buffer/HZB, SSAO/GTAO, SSGI, SSR, temporal/bilateral passes: `1f4084a:src/core/screen_space_effects/**`, `src/passes/ssgi.rs`, `src/passes/ssr.rs`, `tests/test_ssgi_ssr_wiring.py` | Add toggleable stack with debug/AOV outputs and IBL fallback | G | W11 |
| P12 | FP/A | Standard/WBOIT/dual-source OIT: `1f4084a:src/core/dual_source_oit/**`, `src/vector/oit/**`, `tests/test_oit_transparency.py` | Add capability-selected OIT, WBOIT fallback and observable effective mode | G | W12 |
| P13 | FP/A | Bloom, DoF/tilt-shift, lens distortion/CA/vignette: `1f4084a:src/core/bloom/**`, `src/core/dof/**`, `src/shaders/lens_effects.wgsl`, `tests/test_bloom_effect.py`, `tests/test_dof.py`, `tests/test_lens_effects.py` | Add composable post-FX chain, quality settings and debug views | G | W11 |
| P14 | FP/A | Motion vectors/blur, TAA and accumulation AA: `1f4084a:src/core/taa.rs`, `src/viewer/terrain/motion_blur.rs`, `tests/test_motion_vectors.py`, `tests/test_taa_convergence.py`, `tests/test_accumulation_aa.py` | Add camera/object velocity, jitter/history invalidation, TAA and shutter sampling | G | W11 |
| P15 | FP/A | HDR, ACES/Reinhard/gamma/LUT, denoise and color-space correctness: `1f4084a:src/core/hdr.rs`, `src/core/tonemap.rs`, `tests/test_tonemap_lut.py`, `tests/test_terrain_render_color_space.py`, `tests/test_denoise_settings.py` | Add linear HDR graph, selectable tonemap/exposure/LUT and no double conversion | G | W11 |

### Vector, Picking, Labels, And Text

| ID | Life/evidence | Native capability and repository evidence | Current web comparison and required result | Status | Task |
|---|---|---|---|---|---|
| V01 | FP/A | Point impostors/atlas/LOD/shapes, AA lines/caps/joins, polygons and graphs: `1f4084a:src/vector/point/**`, `src/vector/line.rs`, `src/vector/polygon.rs`, `src/vector/graph.rs`, `CHANGELOG.md` 0.80 | Add batched styled point/line/polygon/graph layers and public handles | G | W12 |
| V02 | FI/A | Vector extrusion, batching, frustum culling and indirect draws: `1f4084a:src/vector/extrusion.rs`, `src/vector/batch/**`, `src/vector/indirect/**`, `src/vector/gpu_extrusion/**` | Add GPU extrusion/compute culling with deterministic CPU fallback | G | W12 |
| V03 | FP/A | Vector OIT/pick-map and RGBA compositing: `1f4084a:src/vector/api/**`, `src/vector/oit/**`, `tests/test_vector_overlay_rendering.py` | Add aligned color+pick targets and premultiplied compositing | G | W12 |
| V04 | FP/A | ID/rich picking, terrain hit, selection/highlight/lasso: `1f4084a:src/picking/**`, `tests/test_picking_ipc.py`, `tests/test_picking_premium.py` | Add async point/rect/lasso picks, stable IDs and selection state | G | W12 |
| V05 | FP/A | Point labels, atlas, zoom/depth/horizon, stable IDs, native text rectangles and 3D text meshes: `1f4084a:src/labels/**`, `tests/test_label_api_public_workflow.py`, `tests/test_label_api_stable_ids.py` | Add font atlas and label/text layers with deterministic IDs and placement/removal | G | W13 |
| V06a | FP/A | Flat-line and callout placement: `1f4084a:src/labels/line_label.rs`, `src/labels/callout.rs`, `tests/test_label_api_line_edge_cases.py` | Add geometry placement, leaders and collision integration | G | W13 |
| V06b | DA/B | Curved, terrain-elevated and repeated-path cases are partly experimental: `1f4084a:src/labels/curved.rs`, `tests/test_p2_advanced_labels_repeated_curved.py`, `tests/test_label_plan_terrain.py` | Implement supported cases and return exact typed experimental diagnostics for the remainder | G→C | W13 |
| V07 | FP/A | Typography/fallback/metrics and deterministic `LabelPlan` priorities/keepouts: `1f4084a:src/labels/typography.rs`, `python/forge3d/map_scene.py`, `tests/test_label_plan_determinism.py`, `tests/test_label_plan_keepouts.py` | Add HarfBuzz-WASM shaping, deterministic assets/metrics and label compiler payloads | G | W13 |

### Geospatial Data, Geometry, Acceleration, And Ray Rendering

| ID | Life/evidence | Native capability and repository evidence | Current web comparison and required result | Status | Task |
|---|---|---|---|---|---|
| G01 | FP/A | CRS parsing, EPSG/WKT and coordinate/geometry reprojection: `1f4084a:python/forge3d/crs.py`, `tests/test_crs_reproject.py`, `tests/test_crs_auto.py` | Add PROJ-WASM worker, grid assets, typed metadata and automatic layer reprojection | E | W14 |
| G02 | FP/A | LAZ/COPC/EPT hierarchy/octree/bounds/data: `1f4084a:python/forge3d/pointcloud.py`, `src/pointcloud/{copc,copc_decode,ept,octree}.rs`, `tests/test_copc_laz_fixture.py` | Add browser range IO, LAZ decoder WASM, hierarchy loaders, cancellation/cache | G | W16 |
| G03 | FP/A | Point GPU buffers/budgets/SSE/LOD/colors/viewer controls: `1f4084a:src/pointcloud/renderer.rs`, `src/pointcloud/traversal.rs`, `tests/test_pointcloud_gpu_integration.py`, `tests/test_pointcloud_lod.py` | Add GPU point renderer, octree selection, adaptive budget, styles and stats | G | W16 |
| G04 | FP/B | OGC 3D Tiles traversal/SSE/cache/b3dm/pnts: `1f4084a:src/tiles3d/**`, `python/forge3d/tiles3d.py`, `tests/test_3dtiles_parse.py`, `tests/test_3dtiles_sse.py`; underdeveloped MapScene integration is separately tracked by M02b | Add relative-URL loader, bounds, SSE/cache, b3dm/pnts decode and asset diagnostics | G | W16 |
| G05a | FP/A | GeoJSON/CityJSON/3D Tiles buildings, roofs, extrusion, LOD and scalar materials: `1f4084a:python/forge3d/buildings.py`, `src/import/osm_buildings.rs`, `tests/test_buildings_cityjson.py`, `tests/test_buildings_roof.py` | Add functional geometry, LOD and scalar-material paths | G | W15 |
| G05b | DA/B | Textured-building output is diagnostic-only: `1f4084a:tests/test_p2_building_texture_diagnostics.py`, `tests/test_p2_textured_building_mapscene.py` | Preserve path/UV/format diagnostics and never report a scalar fallback as textured success | G→C | W15 |
| G06 | FP/A | Primitive meshes, polygon extrusion, thick polylines, ribbons/tubes: `1f4084a:src/geometry/primitives.rs`, `extrude.rs`, `thick_polyline.rs`, `curves.rs`; `7b08af8:tests/test_f1_extrude.py` | Add transferable typed mesh constructors | G | W15 |
| G07 | FP/A | Weld/validate/normals, UV/TBN, subdivision/displacement/transforms/simplify/LOD/instancing: `1f4084a:src/geometry/**`, `src/mesh/tbn.rs`; `7b08af8:tests/test_f8_weld.py`, `tests/test_f11_subdivision.py`, `tests/test_f14_transform.py` | Port deterministic algorithms and preserve validation/index/dtype contracts | G | W15 |
| G08 | FP/A | OBJ/MTL, STL, plain glTF/GLB, MultiPolygonZ and image/HDR IO: `1f4084a:python/forge3d/io.py:496-686`, `src/io/**`, `src/formats/hdr.rs`; `7b08af8:tests/test_f4_obj_import.py`, `tests/test_f6_stl_export.py`, `tests/test_f18_gltf_import.py` | Add async URL/File/Blob loaders and Blob/stream exporters; Draco is a separate unverified tombstone | E | W15 |
| G09 | FI/A | CPU BVH/SAH and GPU LBVH/radix/refit: `1f4084a:src/accel/**`; `d14577a:tests/test_bvh_cpu_vs_gpu.py`, `tests/test_mesh_tracing_gpu.py` | Add CPU/WASM builder and WebGPU LBVH/refit with stats/queries | G | W17 |
| G10 | FP/A | SDF primitives/CSG/bounds/hybrid traversal: `1f4084a:src/sdf/**`, `tests/test_api_contracts.py`; `852b74d:tests/test_sdf_python.py` | Add same data model, CPU evaluate and WebGPU hybrid render | G | W17 |
| G11 | FP/A | Deterministic path tracer, progressive/wavefront/hybrid, ReSTIR, AOV/cache/guiding/media/AO/bent-normal/firefly controls: `1f4084a:src/path_tracing/**`; `d14577a:tests/test_path_tracing_api.py`, `tests/test_wavefront_parity.py`, `tests/test_restir.py`, `tests/test_guiding.py`, `tests/test_media_hg.py` | Add WebGPU tracer preserving the final public surface and final internal queues/acceleration | G | W17 |

### Product Scene, Styling, Packaging, Cartography, And Utilities

| ID | Life/evidence | Native capability and repository evidence | Current web comparison and required result | Status | Task |
|---|---|---|---|---|---|
| M01 | FP/A | Structured diagnostics, severity/failure policy and support matrices: `1f4084a:python/forge3d/diagnostics.py`, `tests/test_diagnostics_contract.py`, `tests/test_diagnostics_no_op_policy.py`, `tests/test_diagnostics_support_paths.py` | Add typed deterministic diagnostics, layer summaries, support entries and render-block policy | G | W18 |
| M02a | FP/A | Typed `MapScene` recipe, layers, camera, lighting, output, reproducibility, validation and render: `1f4084a:python/forge3d/map_scene.py`, `tests/test_mapscene_recipe_contract.py`, `tests/test_mapscene_validation.py`, `tests/test_mapscene_render_png.py` | Add browser `MapScene`; bundle save/load adapters are owned by M04/W19 | G | W18 |
| M02b | DA/B | Point-cloud/P1, product-instancing and large-scene support summaries are underdeveloped diagnostics: `1f4084a:tests/test_mapscene_support_status.py`, `tests/test_p2_large_scene_cache_lod_instancing.py` | Preserve exact diagnostics until G02-G04/T13 behavior is integrated and tested | G→C | W18 |
| M03 | FP/A | Mapbox Style subset, expressions, sprites and glyph ranges: `1f4084a:python/forge3d/style.py`, `src/style/**`, `tests/test_style_parser.py`, `tests/test_style_render.py` | Add JSON loader, evaluator, vector/label mapping and unsupported-field diagnostics | G | W19 |
| M04 | FP/A | `.forge3d` manifests/checksums/assets/bookmarks/state/variants and `MapScene.save_bundle/load_bundle`: `1f4084a:python/forge3d/bundle.py`, `python/forge3d/map_scene.py`, `tests/test_bundle_roundtrip.py`, `tests/test_mapscene_save_bundle.py` | Add versioned ZIP/stream bundle with SHA-256, MapScene adapters and URL/File/OPFS round trip | E | W19 |
| M05 | FP/A | Map plate/title/legend/scale/north arrow/inset: `1f4084a:python/forge3d/map_plate.py`, `legend.py`, `scale_bar.py`, `north_arrow.py`, `tests/test_map_plate_layout.py`, `examples/notebooks/map_plate.ipynb` | Add Canvas/OffscreenCanvas composition and PNG/JPEG Blob export | E | W20 |
| M06 | FP/A | SVG/PDF vector export, labels and projection: `1f4084a:python/forge3d/export.py`, `src/export/**`, `tests/test_export_svg.py`, `tests/test_export_projection.py` | Add deterministic SVG and PDF Blobs with projection/validation | E | W20 |
| M07 | FP/B | Colormap registry/stops/CPT/JSON/providers/colors/palettes: `1f4084a:python/forge3d/colormaps/{core,core_palettes,io,providers,registry}.py`, `python/forge3d/colors.py` | Add registry, built-ins, interpolation/import and texture export | G | W20 |
| M08 | FP/A | Offline Ed25519 licensing and Pro gates: `1f4084a:python/forge3d/_license.py`, `src/license/mod.rs`, `tests/test_license.py`, `tests/test_pro_gating.py` | Add WebCrypto Ed25519 with `@noble/ed25519@3.2.0` pure-JS fallback, expiry/grace and feature gates; document browser verification as validity/gating, not tamper-resistant DRM | E | W21 |
| M09 | FP/C | Benchmarks, memory/perf tools and reproducible diagnostics: `1f4084a:python/forge3d/bench.py`, `python/tools/device_diagnostics.py`, `python/tools/perf_sanity.py` | Extend FND-07 to per-operation warmup/stats/throughput/environment/budget API | P | W21 |

### Browser Equivalents And Ecosystem Interop

| ID | Life/evidence | Native mechanism and evidence | Required browser-equivalent capability | Status | Task |
|---|---|---|---|---|---|
| E01 | XC/A | `winit` viewer/binary: `1f4084a:crates/forge3d-native-viewer/src/{lib,main}.rs`, `crates/forge3d-native-viewer/tests/ipc_smoke.rs` | `Forge3DViewer` plus worker `OffscreenCanvas`; DOM accessibility/input replace OS window | P | W02 |
| E02 | XC/A | stdin/TCP NDJSON/subprocess: `1f4084a:python/forge3d/viewer_ipc.py`, `src/viewer/ipc/server.rs`, `src/viewer/event_loop/stdin_reader/**`, `tests/test_viewer_ipc.py` | Direct typed same-realm API, `MessagePort` worker protocol, optional app-owned WebSocket adapter | E | W02 |
| E03 | XC/A | Paths and synchronous files across native loaders/exporters: `1f4084a:crates/forge3d-core/src/io/source.rs`, `python/forge3d/io.py`, `bundle.py`, `export.py` | URL/File/Blob/ArrayBuffer/streams/File System Access/OPFS/download Blob | E | W02 |
| E04 | XC/B | NumPy zero-copy, Matplotlib/IPython/Jupyter widgets: `1f4084a:python/forge3d/widgets.py`, `helpers/ipython_display.py`, `helpers/mpl_display.py`, `tests/test_widgets.py` | TypedArray ownership/shape, borrowed WASM views, `ImageBitmap`, custom element/notebook adapter | E | W02 |
| E05 | XC/A | OS/native TIFF/LAZ/KTX2/HDR/EXR/OIDN/code caches: `1f4084a:src/terrain/cog/**`, `src/pointcloud/copc_decode.rs`, `src/loaders/ktx2/**`, `src/formats/hdr.rs`, `src/util/exr_write.rs`, `python/forge3d/denoise_oidn.py` | Pinned WASM codecs, browser caches and measurable WebGPU denoiser; typed capability errors | E | W22 |
| E06 | XC/A | Dataset registry/fetch and bundled `mini_dem`/boundaries: `1f4084a:python/forge3d/datasets.py`, `python/forge3d/data/mini_dem.npy`, `tests/test_datasets.py` | ESM registry/assets, fetch/cache/integrity and reproducible fixtures | G | W14 |
| E07 | XC/A | PNG/array/display helpers: `1f4084a:python/forge3d/_png.py`, `tests/test_png_io_fallback.py` | ImageData/typed-array PNG encode/decode and browser display adapters | E | W21 |

### Browser-Equivalent Rationale

These substitutions are required by the browser security/execution model, not
scope reductions. Equivalence is accepted only from the outcome tests named in
the last column.

| Native-only mechanism | Rows | Browser equivalent and justification | Equivalence proof |
|---|---|---|---|
| OS window, blocking event loop and native threads | R09-R11, E01 | DOM canvas plus accessible input; worker `OffscreenCanvas`; transferable buffers and optional isolated SAB pool. Browser pages cannot own a `winit` window or block the main event loop | Identical canonical command/state hashes in main/worker modes; rendered pixels compare by recorded SSIM/max-error tolerance, plus input replay, lifecycle/loss and leak tests |
| stdin/TCP/subprocess command server | E02 | Typed same-realm calls and `MessagePort`; optional app-owned WebSocket adapter. Sandboxed pages cannot listen on arbitrary TCP or spawn the native viewer | Protocol conformance, ordering, cancellation, error and replay tests against recorded NDJSON workflows |
| Synchronous paths and native filesystem writes | G08, M04-M06, E03 | URL/File/Blob/ArrayBuffer/streams, File System Access, OPFS and download Blobs. Browsers do not expose arbitrary path IO | Byte/digest round trips, reopen tests, abort/progress, quota and offline-cache tests |
| CPython, NumPy views, Matplotlib/IPython/Jupyter objects | E04, E07 | TypedArray shape/ownership, borrowed WASM views, ImageData/ImageBitmap, custom element and notebook adapter. The browser has no CPython object model | Shape/dtype/ownership tests, zero-extra-copy checks where promised, exact PNG pixels and notebook smoke tests |
| Native ffmpeg, OIDN and dynamically linked TIFF/LAZ/KTX2/HDR/EXR codecs | C06, C08, T10, P05, G02, E05 | WebCodecs+MP4 muxer, measurable AOV-guided WebGPU denoiser and W00 lock-controlled codec builds. A web package cannot load host shared libraries or execute ffmpeg | Codec fixture round trips, timestamp/count checks, SSIM/delta metrics, corrupt-input diagnostics and capability fallbacks |
| Native PROJ database, disk IBL/code caches and Ed25519 library | G01, P06, M08 | Versioned PROJ-WASM grids, CacheStorage/OPFS content-addressed cache, WebCrypto Ed25519 plus `@noble/ed25519@3.2.0` pure-JS fallback | Published coordinate tolerances, cache-key/offline tests and native license vectors including expiry/grace |
| Wheel/package data registry | E06 | ESM asset manifest plus fetch/cache/integrity. Browser packages cannot rely on wheel-relative paths | Digest-verified online/offline fixture loads from the installed tarball |

No equivalent is complete merely because its API exists. Its owner stays `E`
or `P` until the stated outcome proof, browser lifecycle behavior and resource
accounting pass.

## Truthfulness, Lifecycle, And Tombstone Ledger

The matrix above has 84 active capability rows plus seven cross-cutting closure
constraints. The following tracked lineage
items are outside the final parity denominator or constrain how a row is built:

| Item | Lifecycle and evidence | Parity disposition |
|---|---|---|
| `render_raster`, `render_polygons`, `render_raytrace_mesh` | Explicitly removed in `1f4084a:CHANGELOG.md:192-197`; absence is locked by `tests/test_api_contracts.py` | Do not add; their outcomes map to R04, V01-V04 and G11 |
| CSM as a shadow-filter value | `1f4084a:tests/test_shadow_techniques.py` rejects it while `src/shadows/**` implements cascades | Implement CSM as P07 cascade mode, never as a false filter enum |
| VT normal/mask paging | `1f4084a:tests/test_tv20_virtual_texturing.py` and `tests/test_p2_vt_family_validation.py` prove albedo-only runtime | T14a implements albedo; T14b preserves exact unsupported-family diagnostics until new evidence exists |
| Textured building output | `1f4084a:tests/test_p2_building_texture_diagnostics.py` blocks silent scalar success | G05a implements scalar geometry; G05b preserves path/UV/format diagnostics until rendering tests pass |
| Complex shaping and curved/repeated/terrain labels | `1f4084a:tests/test_p2_complex_shaping_decision.py` and `tests/test_p2_advanced_labels_repeated_curved.py` mark cases experimental/deferred | W13 preserves statuses, then promotes only implemented cases |
| MapScene point-cloud, product instancing and large-scene cache/LOD summaries | `1f4084a:tests/test_mapscene_support_status.py` and `tests/test_p2_large_scene_cache_lod_instancing.py` return underdeveloped/unavailable diagnostics | M02b preserves diagnostics; W09/W16/W18 promote them only after behavior passes |
| PLY import and Draco decode | Changelog F13/F18 claims lack a matching final implementation/test; `1f4084a:tests/test_api_contracts.py` does not contract them and final diagnostics reject Draco | `intended-unverified`, not native parity. They remain tracked outside the denominator with this evidence; any implementation is a separately versioned new feature, never a parity claim |
| TV11 page-based terrain shadowing | Design-only history `de6e014`, `5f27c21`, `779f94f`, `ef79523`; no implementation commit | `intended-unverified`; not counted. Existing shadow/clipmap outcomes remain P07/T08 |
| Automatic DEM water detection | Historically shipped, explicitly removed by `e6427c1` | Tombstone; water mask/material/reflection remain T16 |
| HUD | Removed by `771ba4f` and released in `2af9223` (v1.9.1) | Tombstone; accessibility/diagnostics belong in DOM UI, not a recreated HUD |
| Rasterio/xarray/Dask adapters, XYZ/WMTS/Cartopy, Datashader, generic old post-FX demos | Historically shipped, then deleted by `8065223`/`f5ee458` and absent from final API | Tracked historical tombstones. Observable COG/tile/chunk/typed-array outcomes are covered by T09-T11/E04 |
| Historical SVGF/hair/anisotropic path-tracing experiments not in final public API | Historically shipped then removed in the 2025 cleanup | Tombstones, not silently represented as final 1.26 public APIs |
| Python wheels, PyO3/NumPy ABI, CMake and native packaging | Delivery mechanisms removed by `86daa08` | User outcomes map to E01-E05; do not emulate the ABI |
| `vshade` Python compatibility re-export | `1f4084a:python/vshade/__init__.py`; no shipped JavaScript namespace | Delivery alias, not a browser capability; E07 implements the observable PNG/array/display outcomes without inventing an npm alias |
| WebGL fallback and Node rendering | Current support matrix; neither is a native Forge3D capability | Not in parity denominator; WebGPU browser execution is the product boundary |

Deletion is not treated as implicit deprecation. The repository decision at
`bca1ab5:docs/plans/2026-02-20-deprecation-policy-decision.md` records zero Rust
deprecation annotations and zero Python `DeprecationWarning`s while naming
bundle/export/tiles3d/style/pointcloud/SDF/labels as tested, public and active.
Only an explicit retirement such as the v1.13 APIs above can remove a capability
from the denominator.

## Inventory Closure Verification

This revision does not defer discovery to W00. The research pass reconciled the
existing repository evidence now; W00 turns the verified manual mapping into a
permanent machine gate.

| Evidence universe | Observed inventory | Closure in this plan |
|---|---:|---|
| Final migration-stage public contract | 220 effective package-root exports: 207 literal `__all__` entries plus 13 non-duplicated `_BUNDLE_EXPORT_NAMES`; 28 registered classes; 44 registered functions. `a55911f:tests/test_api_contracts.py` also guards at least 100 native symbols and 80 Scene methods | Every symbol/method family maps many-to-one into one of the 84 capability rows; R12/W00 preserves the literal mapping |
| Python API surface | 72 `.py`/`.pyi` files under `1f4084a:python/forge3d` | Public outcomes map to R/C/T/P/V/G/M rows; Python-only delivery mechanics map to XC rows or explicit tombstones |
| Native/WGSL implementation | 1,071 files in the retained monolithic `src/`, cross-checked against compiled `bf8db93` and split-crate copies | Every implementation root maps below; weak Phase-15 shims cannot downgrade earlier tested behavior |
| Behavior tests | 211 root test files, including 191 `test_*.py` files and 1,792 test definitions | Every test maps to a capability, XC constraint or named tombstone; task test lists state the browser port/contract owner |
| Examples | 54 files/assets | W23 requires a runnable browser workflow or consolidated browser example for every original workflow |
| Documentation | 88 assets, including 53 Markdown/RST pages | Feature claims map to matrix rows; W23 generates the reverse evidence report and validates links/code |
| Changelog/history | Releases 0.0.2-1.26.0, explicit v1.13 removals, pre-migration and migration boundaries, later browser commits | Additions map to capability rows; removals/unverified claims map to the tombstone ledger, never silent omission |
| Current browser package | 26 declarations, 12 unit files/80 `it(...)` cases, 14 Playwright specs/38 literal declarations/39 generated cases, six API artifacts, seven fixtures | Existing outcomes are the `I`/`P` entries and are non-regression requirements in every owning task |

The implementation-root cross-check is exhaustive at subsystem level:

| Native root/family | Owning rows |
|---|---|
| `core`, GPU/session, resource, framegraph, timing, buffers | R01-R09 |
| native viewer, offscreen, IPC, widgets/files/codecs | R10-R11, E01-E05 |
| camera, animation, frame/AOV/offline output | C01-C08 |
| terrain, clipmap, COG, overlays, scatter, VT, probes, water | T01-T18 |
| lighting, materials, shadows, atmosphere, screen-space/post-FX | P01-P15 |
| vector, picking, labels, text and typography | V01-V07 |
| CRS, point cloud, 3D Tiles, buildings, geometry/import, BVH, SDF, path tracing | G01-G11 |
| diagnostics, MapScene, style, bundles, cartography, exports, colormaps, licensing, benchmarks | M01-M09 |
| datasets and PNG/array/display adapters | E06-E07 |

The audit found no unmatched public family. The only non-denominator findings
are the explicitly evidenced tombstones above. Matrix splitting makes partial
native contracts computable: T14a/T14b, V06a/V06b, G05a/G05b and M02a/M02b
separately track functional and diagnostic obligations.

## Target Architecture

The finished package keeps two active crates and adds modules rather than
restoring Python/native coupling:

- `forge3d-core`: browser-safe algorithms, data models, scene/render graphs,
  geometry, terrain, acceleration, labels, styles, bundles, WASM-safe codecs,
  and GPU builders behind `gpu`/`webgpu` features.
- `forge3d-web`: wasm-bindgen adapters, async browser IO, canvas/worker runtimes,
  WebGPU pass execution, error normalization and capability negotiation.
- TypeScript facade: scene/viewer/data APIs, cancellation, streams, workers,
  storage adapters, DOM controls and stable types.
- Test assets: restored/converted native goldens and fixtures with provenance in
  the parity manifest.

Every public addition updates these synchronized surfaces in the same change:

- `crates/forge3d-web/src-ts/index.ts` and feature-specific TS modules;
- `crates/forge3d-web/types/index.d.ts`;
- `crates/forge3d-web/tests/api/index.d.ts.snapshot`;
- `tests/api/public-api-consumer.ts` and `public-api-snapshot.mjs`;
- `crates/forge3d-web/docs/browser-api.md` and `README.md`;
- at least one unit test, Playwright test, installed-tarball test, and example.

## Ordered Implementation Tasks

Tasks are ordered by dependency. A task may be split into pull requests, but it
is not complete until every listed matrix row meets its definition of done.

### Working-Tree Task Code-Completion Ledger

This ledger measures **only checked-out code and task-owned artifacts** in
the working tree. The stored W00 browser inventory remains anchored at
`36c1ac251e2a0b1721227f4abd19fbb864636faa`; later source additions count only
when the assessment evidence below names them. It does not award or withhold
completion for physical-browser evidence. `Full` means
every implementation artifact in the task's stated scope exists. `Partial`
means a direct, non-trivial part exists but its stated scope is incomplete.
`None` means no direct implementation artifact for that task exists; incidental
shared dependencies and research in this plan do not qualify. A `Partial` task
is still not functionally complete and does not change any matrix row to `I`.

| Task | Code status | Assessment evidence | Remaining implementation/artifact scope |
|---|---|---|---|
| W00 | Full | The composite manifest/schema/dependency lock, 6,531-record stored inventory, fixture and hardware contracts, semantic verifier tests, `verify:parity` package script and pre-build CI gate are present in the working tree. | None. |
| W01 | Full | The authoritative goals spec, root/package READMEs, support matrix, release checklist, release-hardening contract and docs-link tests distinguish browser delivery, tracked gaps, tombstones and evidence-bound support. | None. |
| W02 | Partial | `crates/forge3d-core/src/gpu/{runtime,surface}.rs` and `crates/forge3d-web/src/runtime/{init,render,diagnostics,device_health}.rs` implement the MVP device/surface lifecycle, diagnostics and coarse resource policy; `Forge3DViewer` supplies main-thread DOM input. FFX-04 adds deterministic pointer, context-menu, wheel, focus, suspension/BFCache, disposal, and property-level `touch-action` contracts; SAF-04 adds bounded SafariDriver interaction plus 30-cycle layout, browser-zoom, BFCache, and Gesture Event absence contracts; FFX-03 adds exact-package branded WebDriver interaction, visibility, benchmark, and 50-cycle resource source coverage without replacing that property-level ownership. | Add scene/pass/resource/memory/timing modules, platform worker/OffscreenCanvas/storage adapters, typed scene/session/config/stats API, graph/resource accounting and R03-R11/E01-E04 behavior. |
| W03 | Full | `crates/forge3d-core/src/terrain.rs` implements validated metadata (spacing/exaggeration/domain/nodata/CRS), physical mesh descriptors, slope/aspect, marching-squares contours, bilinear queries, CPU height AO and sun visibility; `crates/forge3d-web/src/runtime/{terrain,analysis,readback}.rs` implements physical rendering, WebGPU AO/sun compute, grayscale debug views, resident analysis and padded DEM readback; `crates/forge3d-web/src-ts/terrain-dataset.ts` implements `TerrainDataset` with array/File/URL sources, worker-pool decoding, statistics, normalization and named colormaps; coverage spans `cargo test -p forge3d-core`, `tests/unit/terrain-dataset.test.ts` (38 tests), and `tests/playwright/w03_terrain.spec.ts` with `examples/test-w03-terrain.html` also served to the installed-tarball consumer in `scripts/build-browser-test-package.mjs`. | None. |
| W04 | Full | `crates/forge3d-core/src/{lighting,materials,shadowing,codecs,mesh_tbn}` implement typed lights (directional/point/spot/LTC rect, soft falloff, bounds), the 13-model BRDF routing with alias/approximation diagnostics, RGBE decoding, TBN generation and shadow cascade math; `crates/forge3d-web/src/runtime/{lighting,textures,ibl,shadows}.rs` plus `lighting/brdf/ibl_compute/ibl_lighting/shadow_*.wgsl` implement the GPU light/material buffers, textured PBR sampling, WebGPU IBL precompute, six shadow filters and a separate CSM pipeline with budget-admitted map sizes and truthful effective reports; `crates/forge3d-web/src-ts/{lighting,materials,textures,ibl,shadows}.ts` implement `LightCollection`, `MaterialCollection`, `TextureSet`, `Ktx2Loader` (ktx-parse + Basis 2.0.3), `ImageBasedLighting`/`IblCache` (CacheStorage/OPFS) and `ShadowConfig`/`CascadedShadowConfig` ("csm" rejected as a filter); scene commits are atomic across lighting/materials/IBL/shadows. Coverage spans `cargo test -p forge3d-core` (BRDF reference/energy, light, shadow, RGBE, TBN), the W04 vitest suites and `tests/playwright/w04_{materials,ibl,shadows,lifecycle,parity}.spec.ts`; the parity spec matches the native `terrain_pbr_pom` screen-mode golden `tests/golden/w04-terrain-pbr-native.png` at SSIM >= 0.98. CSM stability and peter-panning are asserted by pixel metrics rather than separate image goldens. An independent review during W07 (2026-09-25) corrected native divergences: point/spot lights default to the native light-buffer `inverse-square` attenuation and the soft `linear`/`quadratic`/`cubic`/`exponential` curves and edge-softness window now match `soft_light_radius.wgsl` (quadratic honors the exponent, cubic is `1 - t^3`); presets carry the native `SoftLightPreset` values (`area-light` is a soft point light); IBL tiers use the native `IBLQuality` sizes, 128 irradiance/1024 LUT samples and the native `(1024 >> mip).max(64)` prefilter schedule at `sqrt(mip / (mips - 1))` roughness, with verbatim ports of the native equirect/irradiance/prefilter/BRDF-LUT shaders (cache schema v2), while the native shared-uniform prefilter bug is opt-in (`prefilter: "native"`, used by native-golden comparisons) and `per-mip` is the default; BRDF names resolve with native `normalize_key` in both the TS resolver and the Rust commit validation; the screen path fetches heights through the nearest sampler, uses coarse derivatives and samples the native 256-entry byte colormap LUT, as the native 1.34 oracle does (W04 golden SSIM 0.994 -> 0.9995); the LTC matrix/amplitude LUTs share one texture; and `test-w04-lifecycle.html` adds 30 commit/render/release cycles that return the ledger to the empty-scene state. | None. |
| W05 | Full | `crates/forge3d-core/src/camera/{mod,projection,transforms,screen,dof,controller,animation,rigs}.rs` implement perspective/orthographic `CameraInput`, GL/WebGPU clip-space look-at/projection/view-projection, TRS/normal-matrix transforms, world/screen conversion and picking rays, DOF helpers, orbit/FPS controllers with continuous mode switching, the f32 Catmull-Rom `CameraAnimation`, and orbit/rail/follow terrain rigs with dense clearance verification/refinement plus clamped playback; the web runtime renders orthographic cameras (terrain, scene, lighting and CSM); `crates/forge3d-web/src-ts/{camera,camera-controllers,camera-animation,camera-rigs}.ts` implement `Camera`, `FlyController`, `CameraController` (bindings, serializable input events, deterministic replay), `CameraAnimation`/`RenderConfig`/`RenderProgress` and `TerrainRigSource`/`TerrainOrbitRig`/`TerrainRailRig`/`TerrainTargetFollowRig`, wired into `Forge3DViewer` (fly mode, `setCamera`, recording/replay, loss replay) and `Forge3DSession`. The native oracle fixture `tests/golden/w05-camera-native.json` (generated by `scripts/generate-w05-camera-fixture.py` from native forge3d) is matched within 1e-5 by `cargo test -p forge3d-core --features webgpu` and the W05 vitest suites; `tests/playwright/w05_{camera,package}.spec.ts` cover GPU silhouettes vs `worldToScreen`, orthographic invariance, animation-driven FOV/θ/φ frames, rig playback clearance, fly keyboard/pointer input, replay and device-loss replay. | None. |
| W06 | Full | `crates/forge3d-core/src/{readback,offline,codecs/exr}` implement typed padded-row readback (RGBA8/BGRA8/RGBA16F/RGBA32F/RG32F/R32F/R32U, exact binary16 decode), the native R2/Halton jitter and clip-space jitter, native tile-luminance convergence metrics and trend rule, the native tonemap operators plus a realtime `display` encode, the AOV-guided A-trous denoiser with a noise-scaled luminance edge-stopping term (`edgeStopping: 0` reproduces the native weights), MSE/PSNR/SSIM metrics and bounded `exr@1.74.2` encode/decode with native channel naming; `crates/forge3d-web/src/runtime/offline{.rs,/gpu.rs}` plus `offline_{accumulate,luminance,resolve,tonemap,denoise}.wgsl` and capture-only shader variants of the terrain and world pipelines render HDR color, normalized linear depth, object ID and pixel motion (primary pass) and albedo/shading normal (surface pass) into float targets, accumulate jittered samples, resolve, denoise and tonemap on WebGPU with budget-admitted memory and a session guard; `crates/forge3d-web/src-ts/{frames,offline,frame-stream,video}.ts` implement `Frame`/`HdrFrame`/`AovFrame`, deterministic PNG, `readExr`/`writeExr`, `OfflineQualitySettings`/`DenoiseSettings`/`OfflineProgress`, runtime/session capture and offline sessions, `renderOffline`, `renderFrames`/`createFrameStream`/`writeFrames` with memory/OPFS/download sinks and `FrameDumper`, and WebCodecs `encodeVideo` with deterministic `mediabunny@1.58.0` MP4/WebM muxing and a typed `video-codec-unavailable` diagnostic. Coverage spans `cargo test -p forge3d-core --features webgpu`, `cargo test -p forge3d-web` (naga validation of every capture variant and compute shader), `tests/unit/w06-{offline,frames}.test.ts` and `tests/playwright/w06_{capture,package}.spec.ts`: exact analytic HDR/AOV/depth/ID/motion readback, the `offline-denoise-v1` fixture at 1920x1080 (float color/AOV error 0, depth error 0, sample ladder 1/4/16/64, denoise SSIM gain and MSE reduction far above threshold with converged regression below 1e-6, 120-frame exact-timestamp stream with flat memory), native `render_with_aov` AOVs (`tests/golden/w06-aov-native.{bin,json}`, generated by `scripts/generate-w06-aov-fixture.py`) and the W04 golden beauty at SSIM >= 0.98, device-loss recovery and 30-cycle memory return. | None. |
| W07 | Full | `crates/forge3d-core/src/terrain_material/{mod,texture}.rs` implement the native `TriplanarSettings`/`PomSettings`/`LodSettings`/`SamplingSettings`/`ClampSettings`/`MaterialLayerSettings`/`MaterialNoiseSettings`/`DetailSettings` model with native defaults and validation wording, the `MaterialSet.terrain_default` layer table, uniform packing and deterministic material/aux texture-array assembly (budget downscale, resampling, fallback diagnostics); `crates/forge3d-web/src/runtime/terrain_material{.rs,.wgsl}` port the `1f4084a:src/shaders/terrain_pbr_pom.wgsl` land path and `terrain_noise.wgsl` (triplanar material set, POM, height curves, clamps, snow/rock/wetness with TV4 variation and TV10 subsurface, micro-detail and a detail normal map, layer masks, Toksvig specular-AA tiers, debug views) for screen and perspective terrain behind a `terrain_material` shader feature, with budget-admitted textures and loss replay; `src-ts/terrain-material.ts` and `TerrainHeightmapInput.material` expose `normalizeTerrainMaterial`, `getTerrainMaterialDefaults` and `getTerrainMaterialReport`. `terrain-material-v1` goldens (`tests/golden/w07/`, generated by `scripts/generate-w07-material-goldens.py` from native forge3d 1.34 and including the verbatim `1f4084a` `terrain_pom`/`terrain_tv10_*` goldens) cover 26 variants at SSIM >= 0.98 with native-proportional pixel deltas, and the zero-feature material is byte-identical to the unmaterialed frame (screen mode always runs the native material path, with the default material when none is set). Where native 1.34 (the golden oracle) deterministically realizes `1f4084a` behavior, the port follows it: coarse derivatives, the Y-first `build_tbn` reference axis and sampler-based nearest height fetches. Coverage spans `cargo test -p forge3d-core --features webgpu`, `cargo test -p forge3d-web` (naga validation of every variant), `tests/unit/terrain-material.test.ts` and `tests/playwright/w07_{materials,package}.spec.ts` (contracts, diagnostics, 30-cycle memory, loss replay, 1080p GPU-timestamp p95). | None. |
| W08 | None | Active source has no clipmap, page-table, COG, overlay, virtual-texture, persistent-cache or GeoTIFF-worker module. | Implement T08-T11/T14a-T14b and their range/cache/diagnostic contracts. |
| W09 | None | Active source has no scatter, QEM/HLOD, instancing, wind, SH-probe or reflection-probe module. | Implement T13/T15 generators, GPU paths, policies, reports and tests. |
| W10 | None | Active source has no ephemeris, sky, fog/volume, cloud or water module. | Implement T16-T17/P08-P10 environment, atmosphere, water and cloud pipelines. |
| W11 | None | Active source has no G-buffer/HZB, screen-space, post-FX, temporal or HDR/tonemap module. | Implement P11/P13-P15 ordered post-FX and temporal/color pipeline. |
| W12 | None | Active source has no vector, picking, OIT, selection or layer-handle module. | Implement T12/P12/V01-V04 geometry, render, pick and fallback paths. |
| W13 | None | Active source has no labels, shaping/font, declutter, callout or `LabelPlan` module. | Implement V05-V07 typography, placement, diagnostics and deterministic plan API. |
| W14 | None | Active source has no CRS transform, dataset registry, PROJ-WASM adapter, grids or integrity cache. | Implement G01/E06 transforms, registry, fixtures and offline cache. |
| W15 | None | Active source has no geometry, mesh, importer/exporter, building or glTF/OBJ/STL module. | Implement G05a-G05b/G06-G08 data/IO/mesh/building paths and diagnostics. |
| W16 | None | Active source has no pointcloud, COPC/EPT/LAZ or `tiles3d` module. | Implement G02-G04 loaders, decoders, traversal, GPU render, caches and diagnostics. |
| W17 | None | Active source has no accel/BVH, SDF/CSG or path-tracing module. | Implement G09-G11 CPU/WASM and WebGPU tracing, AOV and progressive APIs. |
| W18 | Partial | `types/index.d.ts:126-153` and `src-ts/viewer.ts:225-243` expose MVP viewer diagnostics. No `MapScene` type, recipe or layer model exists. | Implement structured support/failure diagnostics plus M02a/M02b recipe, validation, render and exact no-op contracts. |
| W19 | None | Active source has no style/expression, sprite/glyph, bundle, checksum, variant or review-state module. | Implement T18/M03/M04 style, ZIP bundle and variant workflows. |
| W20 | None | The terrain-local `TerrainColorRampInput` is not an M07 registry; no map-plate, SVG or PDF export artifact exists. | Implement M05-M07 cartography/layout, vector export and colormap ecosystem. |
| W21 | Partial | The checked-in FND-07 benchmark harness exists at `tests/browser/viewer-benchmark.ts` and `tests/browser/benchmark/**`; `ViewerResourcePreset` is only an MVP allocation policy. | Add offline licensing/gates, public PNG/array utilities/display adapters and public benchmark/memory API; renderer presets remain W02/R04-owned. |
| W22 | None | No direct integrated E05 codec registry, codec dispatch contract or AOV-guided denoiser artifact exists. | Integrate and verify the codec registry/denoiser after feature codecs land; platform adapters remain W02-owned. |
| W23 | Partial | Browser docs, seven HTML fixtures, the Vite example and W00's exhaustive native-to-web inventory/provenance map exist. Converted goldens and runnable migrated evidence for every original workflow are not restored. | Add all-row documentation/example/test/golden migration evidence and enforce its coverage report. |
| W24 | Partial | R01 runtime/recovery, package/browser contracts, support matrix, hardware workflows, FND-07 harness and W00 `verify:parity` gate are present. FFX-03/FFX-04 and SAF-04 add exact-package, hardware-bound, and fail-closed lifecycle source-proof contracts, but no qualifying physical Firefox or Safari execution; most matrix rows remain G/P/E. | Complete W01-W23, obtain the required physical browser evidence, then add the final parity report and close every package, browser, performance and recovery release gate. |

The per-task **Code status** lines below duplicate this ledger deliberately so a
task remains unambiguous when read or reviewed in isolation.

### W00 — Freeze The Parity Manifest And CI Gate

- Code status: **Full** — the composite manifest, dependency ADR lock, stored inventories, fixture/hardware contracts, semantic verifier, package script and pre-build CI gate are implemented; see the working-tree ledger above.

- Scope: R12, all 84 capability rows and all seven cross-cutting constraints.
- Files/APIs: add `docs/parity/forge3d-composite-baseline.json`,
  `docs/parity/schema.json`, `docs/parity/dependency-lock.json`,
  `scripts/verify-parity-manifest.mjs`, and inventory fixtures under
  `crates/forge3d-web/tests/parity/`; update package scripts and
  `.github/workflows/web.yml`. The dependency lock is an ADR-grade record for
  each lock-controlled WASM/package asset: version, source digest, license, build
  provenance, fixture provenance, CSP/SRI delivery rule and consuming task.
- Dependencies: Git object access during generation; no runtime dependency.
  Store generated evidence so release verification does not require the old
  commit to be checked out.
- Tests: schema, uniqueness and referential integrity; compare `bf8db93`/earlier
  semantic provenance, `1f4084a` reconciliation, `a55911f` final contracts and
  current browser additions. Inventory all exports, PyO3 registrations, Scene
  method families, 191 named test files/1,792 test definitions, 54 examples, 88
  documentation assets/53 Markdown-RST pages, changelog headings and inactive
  module roots; validate dependency-lock entries for HarfBuzz, PROJ, LAZ,
  GeoTIFF, Basis/KTX2, EXR, MP4 muxing, ZIP and PDF assets before build/test.
- Acceptance: every public symbol, method family, test, example, doc feature,
  module root and changelog addition across all four baseline layers maps to
  exactly one capability ID and one
  web API/equivalent/tombstone; zero or more separately typed `XC` links may
  express cross-cutting browser constraints. Blank owner/evidence/test fields
  fail CI.
- Definition of done: `npm run verify:parity` is a required clean-checkout gate
  and reports zero untracked, duplicate or unresolved entries; it also rejects
  a consumer of a lock-controlled asset that lacks a matching lock/ADR entry.

  The lock freezes exact digests, licenses, build/fixture provenance and CSP/SRI
  rules for: `harfbuzzjs@1.6.0`, `proj-wasm@0.1.0-alpha9`,
  `geotiff@3.0.5`, `laz-perf@0.0.7`, `ktx-parse@1.1.0` plus the Basis Universal
  2.0.3 WASM build, `exr@1.74.2` with default `rayon` disabled for WASM,
  `mediabunny@1.58.0`, `fflate@0.8.3`, `pdf-lib@1.17.1` plus lock-pinned
  `@pdf-lib/fontkit@1.1.1`, and `@noble/ed25519@3.2.0` pure-JS fallback.
  `proj-wasm` and `laz-perf` are experimental/maintenance-risk entries and
  require fixture conformance, security and license review. A substitution
  requires an ADR plus the same fixture suite.

  Required manifest fixture IDs are `dem-synthetic-v1`, `terrain-material-v1`,
  `clipmap-seam-v1`, `volume-temporal-v1`, `crs-epsg-v1`, `mesh-io-v1`,
  `copc-ept-tiles-v1`, `trace-sdf-v1`, and `offline-denoise-v1`. Required
  hardware profiles are `reference-discrete` (>=8 GiB adapter budget plus
  timestamp-query) and `reference-integrated` (>=4 GiB effective budget); each
  records exact adapter, driver and OS. Blank fixture, tolerance, budget or
  profile fields fail CI.

### W01 — Replace Obsolete Scope Contracts

- Code status: **Full** — authoritative scope and package/release contracts now preserve browser-only delivery while tracking every native outcome, tombstone and feature gap.

- Scope: plan/spec/package truthfulness.
- Files/APIs: update
  `docs/superpowers/specs/2026-06-05-forge3d-browser-webgpu-wasm-migration-goals.md`,
  `crates/forge3d-web/tests/api/release-hardening.mjs:320-323`, README, support
  matrix and release checklist. Preserve browser-only packaging while removing
  functional-parity exclusions.
- Dependencies: W00 terminology and manifest schema.
- Tests: API/release-hardening and docs-link tests verify no untracked exclusion
  language and no false support claim.
- Acceptance: docs distinguish delivery-format exclusions, tombstones and
  feature gaps; every unsupported capability links to a matrix row and task.
- Definition of done: repository search finds no authoritative statement that
  native functionality is outside the parity target.

### W02 — General Scene/Render Graph, Resources, Diagnostics, And Config

- Code status: **Partial** — the MVP runtime/lifecycle foundation exists, but no general scene/render-graph/resource/config implementation exists; see the working-tree ledger above.

- Scope: R03-R11 and E01-E04.
- Files/APIs: add core `scene/`, `render_graph/`, `resources/`, `memory/` and
  `timing/`; split the web runtime into scene/pass/resource owners; implement
  Worker/`MessagePort`/`OffscreenCanvas`, storage-source/sink, transferable and
  borrowed-view ownership, SAB/single-worker/main-thread fallback adapters,
  File System Access/OPFS fallback and notebook/custom-element adapters; add TS
  `Forge3DSession`, `Forge3DScene`, `RendererConfig`, `RenderStats`,
  `MemoryReport`, capabilities and presets.
- Dependencies: existing wgpu 29 runtime; WebGPU timestamp-query when exposed;
  CPU timing fallback; W00/W01. W02 owns only generic material/light slots and
  validation schemas; their lighting/material rendering semantics are deferred
  to the dedicated lighting task.
- Tests: graph ordering/cycle detection, resource alias/lifetime, budget
  overflow/downscale, loss replay, resize/disposal, timestamp fallback, config
  round trip, ground-plane/text-mesh nodes and preset snapshots; worker/main
  conformance, ARIA/focus/pointer/wheel/keyboard replay, no-SAB, FSA/OPFS
  unavailable/quota behavior, and borrowed-view memory-growth/dispose/transfer.
- Acceptance: multiple layer/pass types coexist; resources are accounted once;
  lost devices rebuild the same scene; budgets reject or downscale before OOM.
- Definition of done: R03-R11/E01-E04 are `Implemented`, leak counters return to zero
  after 30 create/render/loss/dispose cycles, and existing FND tests stay green.

### W03 — DEM Data Model, Colormaps, Analysis, AO, And Terrain Queries

- Code status: **Full** — DEM model, metadata/statistics/normalization/nodata/CRS,
  physical rendering, CPU and WebGPU slope/aspect/contour/AO/sun analysis,
  terrain queries, resident analysis readback, debug views, typed `TerrainDataset`
  sources and worker decoding are implemented with Rust, unit, API, browser and
  installed-package coverage; see the working-tree ledger above.

- Scope: T01-T04.
- Files/APIs: expand core terrain data/mesh/analysis; add worker-capable DEM
  decoder and TS `TerrainDataset`, statistics, normalization, analysis/query;
  extend inputs with spacing, exaggeration, domain, nodata, CRS and colormap.
- Dependencies: W02 resources and worker/service interfaces. This task owns
  the minimal colormap interface needed by terrain.
- Tests: port DEM/grid/colormap/analysis/height-AO/sun-visibility tests; exact
  synthetic slopes/contours; NaN/nodata/errors; compute/CPU parity.
- Acceptance: W00 fixtures require DEM scalar abs/rel error <= 1e-6,
  slope/aspect <= 1e-4 rad, contour Hausdorff <= 0.25 cell and AO/sun maximum
  absolute error <= 0.02; large inputs avoid a second full-size copy and obey
  the manifest resource budget.
- Definition of done: T01-T04 examples run from arrays, `File` and URL in the
  installed package.

### W04 — Shared Lights, BRDFs, Textures, IBL, And Shadows

- Code status: **Full** — typed lights, BRDF routing, PBR textures/TBN/KTX2, WebGPU IBL
  with CacheStorage/OPFS caching, six shadow filters and a separate CSM pipeline
  are implemented with Rust, unit, API, browser and native-golden coverage; see
  the working-tree ledger above.

- Scope: P01-P07.
- Files/APIs: port lighting/material/shadow/IBL core and WGSL; TS light/material
  collections, texture sets, IBL and shadow config; cache precomputed IBL.
- Dependencies: W02; in-repo minimal Radiance RGBE decoder
  `crates/forge3d-core/src/codecs/rgbe.rs` owned as P05/P06 infrastructure;
  `ktx-parse@1.1.0` plus Basis Universal 2.0.3 WASM; CacheStorage/OPFS;
  optional timestamp-query; W00 dependency-lock entry for Basis/KTX2.
- Tests: light mutation/bounds, BRDF references/energy, TBN/normal/KTX2, IBL
  sweeps, six filter families and separate CSM stability/peter-panning goldens.
- Acceptance: all selections are observable/validated; CSM is not a filter;
  unsupported formats select a documented effective quality without lying.
- Definition of done: P01-P07 meet packing, SSIM >= 0.98, memory and recovery
  criteria.

### W05 — Complete Camera, Transform, Controller, Animation, And Rig APIs

- Code status: **Full** — perspective/orthographic cameras, GL/WebGPU projections, transforms, world/screen conversion, DOF helpers, orbit/fly controllers with bindings and deterministic replay, Catmull-Rom camera animation and clearance-verified terrain rigs are implemented in core and TypeScript, matched against a native oracle within 1e-5 and covered by unit, browser and installed-package tests; see the working-tree ledger above.

- Scope: C01-C04.
- Files/APIs: add core camera animation/rig/transform modules; TS `Camera`,
  `CameraAnimation`, keyframes, `FlyControls`, orbit/rail/follow rigs; extend
  viewer controls and scene serialization.
- Dependencies: W02 scene state; existing `glam`; W03 terrain sampler.
- Tests: port animation/rig/projection/transform tests; pointer/keyboard
  controller switching; deterministic keyframes/rigs; clearance edge cases.
- Acceptance: native sample paths and matrix results match within 1e-5;
  clearance never violates its minimum; loss replay is identical.
- Definition of done: C01-C04 APIs, docs, package example and browser tests pass.

### W06 — General Readback, AOV/HDR/EXR, Offline Quality, Frames, And Video

- Code status: **Full** — typed float/uint readback, HDR/AOV (albedo, normal, depth, ID, motion) capture, EXR, native-parity offline accumulation with adaptive convergence, the AOV-guided WebGPU A-trous denoiser, deterministic frame sequences with OPFS/download sinks and WebCodecs MP4/WebM export are implemented and covered by Rust, unit, browser, native-golden and installed-package tests; see the working-tree ledger above.

- Scope: R02 and C05-C08.
- Files/APIs: generalize core/web readback; add targets/offline controller; TS
  `Frame`, `HdrFrame`, `AovFrame`, `renderOffline`, frame stream, EXR and video
  export.
- Dependencies: W02 render graph, W05 camera; `exr@1.74.2` with default rayon
  disabled for WASM; WebCodecs plus `mediabunny@1.58.0`; WebGPU A-trous/bilateral denoiser;
  W00 dependency-lock entries for EXR and MP4.
- Tests: channel/value readback, row padding, EXR metadata/round trip,
  convergence metrics, cancellation/progress, exact frame timestamps/counts,
  unavailable-codec diagnostic and native-golden SSIM >= 0.98.
- Acceptance: float color/AOV maximum absolute error is <=1e-5 and depth is
  <=1e-6 on `offline-denoise-v1`; noisy denoise SSIM gain is >=0.02 with MSE
  reduction >=20%, while converged SSIM regression is <=0.005.
- Definition of done: R02/C05-C08 pass unit, Playwright, installed-tarball and
  long-run memory tests.

### W07 — Terrain PBR/POM And Layered Materials

- Code status: **Full** — native terrain PBR/POM material model, WGSL land-path port, layered materials with variation/subsurface, micro-detail and specular-AA tiers are implemented and matched against native `terrain-material-v1` goldens (including the historical `1f4084a` POM/TV10 goldens) with unit, browser and installed-package coverage; see the working-tree ledger above.

- Scope: T05-T07.
- Files/APIs: port terrain PBR/POM/noise/detail shaders and parameter models;
  add material layers, SSS, normal/specular AA and texture bindings.
- Dependencies: W02 graph, W03 terrain and W04 shared lighting/material
  semantics.
- Tests: port renderer/material/TV4/TV10/color goldens; zero-feature baseline;
  invalid parameters and missing-texture diagnostics; SSIM >= 0.98.
- Acceptance: every listed material toggle has a W00 golden SSIM >= 0.98 and
  non-zero manifest-defined pixel delta while defaults preserve baseline;
  p95 frame time is <=16.7 ms on reference-discrete and <=33.3 ms on
  reference-integrated 1080p profiles, with peak GPU allocation <= budget.
- Definition of done: T05-T07 pass required WebGPU lanes within the recorded
  native-quality performance budget.

### W08 — Clipmaps, Streaming, COG, Raster Overlays, And Virtual Textures

- Code status: **None** — no direct clipmap/streaming/COG/VT implementation artifact exists; see the working-tree ledger above.

- Scope: T08-T11 and T14a-T14b.
- Files/APIs: add core clipmap/page-table/cache/VT modules; web range scheduler,
  GeoTIFF worker and storage caches; TS COG/streaming/overlay/VT APIs.
- Dependencies: W02/W03/W04; `geotiff@3.0.5`; IndexedDB,
  CacheStorage and OPFS; AbortSignal; documented CORS/range requirements; W00
  dependency-lock entry for GeoTIFF.
- Tests: port clipmap/geomorph/LOD/COG/overlay/VT tests; mocked range server;
  dedupe/cancel/prefetch/eviction/checksum/offline cases; albedo VT goldens and
  normal/mask diagnostics.
- Acceptance: triangle/residency stay within 5% of the W00 budget; cracks are
  <=0.5 px and height discontinuity <=1e-4 of elevation range; range/cache
  stats are observable and overlay order/blends deterministic.
- Definition of done: T08-T11/T14a-T14b work from real COG and synthetic fixtures
  without full download and survive device-loss/cache replay.

### W09 — Terrain Scatter, LOD/HLOD, Wind, And Lighting Probes

- Code status: **None** — no direct scatter/HLOD/wind/probe implementation artifact exists; see the working-tree ledger above.

- Scope: T13 and T15.
- Files/APIs: port scatter generators/filters/QEM LOD/clustering/GPU instancing,
  contact/blend/wind and SH/reflection probes; expose typed batches, policies,
  stats and memory reports.
- Dependencies: W02 scene contracts, W05 animation, W06 offline outputs, W03
  sampler, W07 materials and W04 lighting. This task owns the QEM/HLOD subset
  needed by scatter.
- Tests: port scatter/TV13/TV21/TV22/probe tests; deterministic seeds; bounds,
  activation and invalid-wind cases; memory and visual goldens.
- Acceptance: transforms max abs <=1e-5; every AABB contains each instance with
  <=1e-5 scene-diagonal slack; fixed seed/time hashes are exact; SH coefficient
  max abs <=1e-3, probe SSIM >=0.98, and allocation <= manifest budget.
- Definition of done: T13/T15 pass scene, viewer, offline and recovery paths.

### W10 — Sun, Sky, Volumetrics, Clouds, Water, And Terrain Atmosphere

- Code status: **None** — no direct environment/atmosphere/water/cloud implementation artifact exists; see the working-tree ledger above.

- Scope: T16-T17 and P08-P10.
- Files/APIs: port ephemeris, sky, fog/froxel, density-volume, cloud/shadow and
  water/foam/reflection passes; TS environment and water-layer APIs.
- Dependencies: W02 history/environment contracts, W03 terrain and W04
  lighting.
- Tests: port sun/sky/volumetric/TV6/water/atmosphere/cloud tests; sunrise,
  occluded god rays, reflection/foam masks, deterministic wind and half-res
  upscale.
- Acceptance: UTC sun vectors meet W00 tolerance; volume contribution outside
  declared bounds is <=1/255; water/cloud goldens meet SSIM >=0.98; terrain and
  general scenes share one atmosphere within the configured GPU budget.
- Definition of done: scoped rows pass goldens, quality, resize, loss and memory
  tests.

### W11 — Screen-Space, Temporal, Post-FX, HDR, And Color Pipeline

- Code status: **None** — no direct screen-space/post-FX/temporal/color implementation artifact exists; see the working-tree ledger above.

- Scope: P11, P13-P15.
- Files/APIs: port G-buffer/HZB, SSAO/GTAO/SSGI/SSR, bloom, DoF, lens, motion,
  TAA, HDR and tonemap; expose a typed ordered post-FX chain.
- Dependencies: W02/W05/W04/W10.
- Tests: port P5/bloom/DoF/lens/motion/TAA/tonemap/color tests; history
  invalidation; pass-order snapshots; native-golden SSIM >= 0.98.
- Acceptance: passes toggle independently; debug views expose intermediates;
  temporal disocclusion has 95% error decay within 8 frames and converged
  flicker <=1/255; linear color persists until final output.
- Definition of done: P11/P13-P15 pass with deterministic device-format
  fallbacks.

### W12 — Vector Layers, Drape, OIT, Culling, Picking, And Selection

- Code status: **None** — no direct vector/picking/OIT implementation artifact exists; see the working-tree ledger above.

- Scope: T12, P12 and V01-V04.
- Files/APIs: port vector/picking modules and shaders; TS layer handles/styles,
  drape, pick queries/events, selection, highlights and lasso.
- Dependencies: W02/W03/W04/W11.
- Tests: port vector/OIT/picking tests; pixel-accurate IDs; AA joins/caps;
  culling fallback; lasso ordering; WBOIT versus dual-source selection.
- Acceptance: color/pick align, IDs survive edits, drape avoids z-fighting and
  effective fallback mode is observable.
- Definition of done: rows pass unit/browser/package tests plus Luxembourg and
  picking examples.

### W13 — Labels, Typography, Declutter, Callouts, And LabelPlan

- Code status: **None** — no direct labels/typography/declutter implementation artifact exists; see the working-tree ledger above.

- Scope: V05-V07.
- Files/APIs: port label manager/collision/declutter; add `harfbuzzjs@1.6.0`
  and deterministic fonts; TS label layers, typography, diagnostics and
  `LabelPlan`; add `docs/parity/label-case-contract.json` that assigns every
  curved, repeated-path and terrain-elevated case one of `render` or the exact
  native diagnostic result/reason.
- Dependencies: W02 diagnostic contracts, W05 cameras, W03 sampler and W12
  vector/picking; W00 dependency-lock entry for HarfBuzz.
- Tests: port every label API/plan/typography/P2 shaping/curved test; coverage,
  keepouts, IDs, serialization, repeated paths and terrain elevation.
- Acceptance: identical candidates produce identical accepted/rejected order
  and reasons; complex scripts shape deterministically; experimental cases stay
  diagnostic until functional cases pass. The label-case manifest is exhaustive
  and is the only source of truth for render-versus-diagnostic outcomes.
- Definition of done: V05-V07 are rendered or exact contract-only per case,
  never silent no-ops.

### W14 — CRS And Dataset Foundation

- Code status: **None** — no direct CRS/dataset/PROJ implementation artifact exists; see the working-tree ledger above.

- Scope: G01 and E06.
- Files/APIs: TS CRS transforms and dataset registry/fetch/cache/integrity;
  worker adapter, grids and bundled fixtures.
- Dependencies: W02 storage/worker contracts and `proj-wasm@0.1.0-alpha9` with
  versioned grid assets; W00 dependency-lock entry for PROJ and grid fixtures.
- Tests: port CRS/dataset tests; EPSG/WKT, axis order, geometry, missing grid,
  cache/digest/offline/abort cases.
- Acceptance: W00 fixtures are <=1e-7 degrees geographic or <=0.01 m projected
  with round-trip <=0.02 m; missing grids fail structurally rather than applying
  identity.
- Definition of done: G01/E06 work from installed package and offline cache.

### W15 — Geometry, Mesh Processing, IO, Textures, And Buildings

- Code status: **None** — no direct mesh/geometry/import/export/building implementation artifact exists; see the working-tree ledger above.

- Scope: G05a-G05b and G06-G08.
- Files/APIs: port geometry/import/io/mesh/UV modules; TS mesh buffers,
  operations, async loaders/exporters and building layers; W15 owns the plain
  glTF/GLB decoder later consumed by b3dm and exposes the public HDR IO wrapper
  while consuming W04's in-repo RGBE decoder.
- Dependencies: W02 platform/storage contracts, W04 materials, browser streams
  and W14 CRS. Draco/PLY are new-feature choices, not required to close parity.
- Tests: port geometry/TBN/IO/CityJSON/building tests; OBJ/STL round trips,
  plain glTF/GLB fixtures, topology diagnostics, LOD bounds and instancing.
- Acceptance: format-preserving counts/topology are exact; position/normal/UV/TBN
  maximum absolute error <=1e-5; bounds and round-trip Hausdorff <=1e-5 scene
  diagonal on `mesh-io-v1`; building diagnostics never imply textured success.
- Definition of done: G05a-G05b/G06-G08 pass installed-package examples with
  transferable buffers and no filesystem assumption.

### W16 — Point Clouds And OGC 3D Tiles

- Code status: **None** — no direct point-cloud/COPC/EPT/3D-Tiles implementation artifact exists; see the working-tree ledger above.

- Scope: G02-G04.
- Files/APIs: port pointcloud/tiles modules; TS datasets/layers, SSE/LOD,
  decoders, caches, stats and diagnostics. b3dm extracts its payload then calls
  W15/G08's plain-glTF decoder; W16 owns no glTF decoder.
- Dependencies: W02/W05/W08/W04/W14/W15 and `laz-perf@0.0.7`; W00
  dependency-lock entry for LAZ.
- Tests: port COPC/LAZ/EPT, point-buffer/LOD and tile parse/SSE tests; corrupt
  chunks, cancellation, external URIs, pressure, picking and loss.
- Acceptance: `copc-ept-tiles-v1` counts/colors and recorded camera-node/SSE
  selections are exact; bounds max absolute error <=1e-5 dataset span; initial
  ranged view fetches <=25% fixture bytes with no non-Range body fetch; the
  10-minute traversal p95 is <=16.7/33.3 ms by profile and allocation <= budget.
- Definition of done: G02-G04 pass real-data examples and long traversal within
  W00 budgets.

### W17 — BVH/LBVH, SDF/CSG, And Path Tracing

- Code status: **None** — no direct BVH/SDF/path-tracing implementation artifact exists; see the working-tree ledger above.

- Scope: G09-G11.
- Files/APIs: port accel/SDF/path-tracing modules and WGSL; TS BVH, SDF scene,
  path tracer, progressive iterator, AOV, ReSTIR/cache/guiding/media APIs.
- Dependencies: W02/W06/W04/W16 and WebGPU compute; use the worker/service
  contracts established by W02.
- Tests: port final API SDF/BVH and shipped path-tracing behavior tests;
  deterministic seeds, BVH/refit, CSG distance/material, queue compaction,
  progressive cancellation, AOV/cache/ReSTIR/guiding/media.
- Acceptance: on `trace-sdf-v1` CPU/GPU hit IDs and fixed-seed hashes are exact;
  t/barycentric max abs <=1e-5, SDF max abs <=1e-4 scene diagonal with exact
  material, RMSE strictly decreases at 1/4/16/64 spp and 64-spp SSIM >=0.98.
- Definition of done: G09-G11 pass compute-capable lanes and return structured
  limit diagnostics when genuinely unavailable.

### W18 — Diagnostics And Typed MapScene

- Code status: **Partial** — MVP viewer diagnostics exist, but structured MapScene/support behavior does not; see the working-tree ledger above.

- Scope: M01 and M02a-M02b.
- Files/APIs: TS diagnostics/support models and `MapScene` recipe/layer/output;
  integrate every completed layer.
- Dependencies: W02 and layer APIs W03-W17.
- Tests: port all diagnostics/MapScene tests; serialization, support matrices,
  failure policy, recipe validation, PNG render and no-op detection.
- Acceptance: validation enumerates every layer/resource before rendering;
  unsupported/Pro/experimental paths cannot report success.
- Definition of done: M01/M02a-M02b have zero silent placeholders and deterministic
  bundle-ready reports.

### W19 — Mapbox Style, Bundles, Variants, And Review Layers

- Code status: **None** — no direct style/bundle/variant implementation artifact exists; see the working-tree ledger above.

- Scope: T18 and M03-M04.
- Files/APIs: port style/expression/sprite/glyph and bundle models; TS loader,
  `.forge3d` save/load and variant/review state.
- Dependencies: W02 storage contracts, W12/W13/W18, `fflate@0.8.3` and
  WebCrypto SHA-256; W00 dependency-lock entry for ZIP.
- Tests: port style/bundle suites; expression conformance, unsupported fields,
  sprite/glyphs, checksum tamper, asset rewrite, migration, round trip and
  atomic variants.
- Acceptance: supported styles render; unsupported fields diagnose; bundles
  round-trip offline and verify every asset.
- Definition of done: T18/M03/M04 pass URL/File/Blob/OPFS and package workflows.

### W20 — Map Plates, Vector Export, And Colormap Ecosystem

- Code status: **None** — the MVP terrain ramp is not this task's registry/export implementation; see the working-tree ledger above.

- Scope: M05-M07.
- Files/APIs: TS map plate/furniture/layout, SVG/PDF export and colormap registry;
  worker-compatible composition.
- Dependencies: W06/W12/W13/W18; `pdf-lib@1.17.1` plus lock-pinned `@pdf-lib/fontkit`; browser fonts and
  Canvas/OffscreenCanvas; W00 dependency-lock entry for PDF.
- Tests: port layout/export/projection/colormap tests; deterministic SVG, PDF
  parse/render smoke, scale distance, north arrow, inset, CPT/JSON.
- Acceptance: layout is within 1 px; SVG validates; PDF contains expected
  page/vector/text objects; all exports are Blobs.
- Definition of done: M05-M07 reproduce native cartographic workflows fully in
  the browser.

### W21 — Licensing, Array/PNG Utilities, And Benchmarks

- Code status: **Partial** — an internal browser benchmark harness exists, but licensing and public utilities do not; renderer presets are owned by W02/R04; see the working-tree ledger above.

- Scope: M08-M09 and E07.
- Files/APIs: TS license manager, image/array helpers and benchmark API. The
  renderer preset catalog is exclusively W02/R04-owned; dataset ownership is
  exclusively W14/E06-owned.
- Dependencies: WebCrypto Ed25519 plus `@noble/ed25519@3.2.0` pure-JS fallback; W02 timing/memory;
  W02 storage contracts; browser image decode/canvas fallback.
- Tests: port license/gating/PNG/benchmark tests; bad/expired/grace
  signatures, image round trip, warmup stats and environment.
- Acceptance: verification is offline and only provides validity/expiry/grace
  and client API gating, not tamper-resistant DRM; sensitive server/data
  entitlements remain server-side. PNG RGBA8 round trips exactly; benchmark
  schema is stable and consumes the typed renderer config from W02.
- Definition of done: rows pass without Python, Node rendering or network
  license validation.

### W22 — Codec Registry, Denoiser, And Integration

- Code status: **None** — no direct integrated E05 codec registry or denoiser artifact exists; platform adapters are W02-owned; see the working-tree ledger above.

- Scope: E05 only.
- Files/APIs: integrated codec registry, codec dispatch/capability contract and
  AOV-guided WebGPU denoiser; feature tasks own their individual decoders.
- Dependencies: W02 platform adapters; W06/W08/W04/W13/W15/W16 feature codecs;
  W00 dependency-lock entries for every dispatched codec.
- Tests: codec fixture conformance, corrupt-input capability errors, cache-key
  replay, denoiser SSIM delta and registry disposal.
- Acceptance: every E05 fixture has one selected codec or exact typed unavailable
  result; cache round-trip is byte-exact and corrupt inputs are typed; on
  `offline-denoise-v1` denoise gains SSIM >=0.02/MSE >=20% with converged
  regression <=0.005.
- Definition of done: E05 is `Implemented` without changing platform ownership.

### W23 — Restore Documentation, Examples, Goldens, And Migration Guides

- Code status: **Partial** — MVP docs/examples exist, but no exhaustive migrated evidence/provenance coverage exists; see the working-tree ledger above.

- Scope: evidence coverage for all rows and tombstones.
- Files/APIs: expand package docs/examples; restore converted fixtures/goldens
  with provenance; add Python-to-TypeScript map and generated feature/support
  pages.
- Dependencies: W03-W22 behavior.
- Tests: doc links/code blocks, example build/run, asset digests, goldens and a
  manifest rule requiring an example or explicit contract test per row.
- Acceptance: all 54 final examples map to runnable browser examples or a
  consolidated example executing every original workflow; all 88 documentation
  assets/53 Markdown-RST pages and all 191 named tests/1,792 test definitions
  map to browser/core/package/contract/tombstone evidence.
- Definition of done: the coverage report has no unmapped source, export, test,
  example, doc feature or changelog capability.

### W24 — Cross-Browser, Performance, Recovery, Packaging, And Final Closure

- Code status: **Partial** — the MVP release infrastructure and R01 exist, but parity closure artifacts and most scoped implementation do not; this code-artifact status is independent of physical-browser runs; see the working-tree ledger above.

- Scope: R01 and final verification of all 91 tracked rows.
- Files/APIs: extend browser/hardware matrix, benchmarks, release checklist,
  package contracts, support publication and parity report.
- Dependencies: W00-W23.
- Tests: clean Rust/wasm/TypeScript/API/package/consumer checks, every Playwright
  project, physical browser evidence, loss/visibility/BFCache, memory soak,
  goldens and real data.
- Acceptance: no `G`, `P`, `E` or `G→C`; every verified `C` row returns the
  exact typed status and is not advertised as
  rendering; visuals meet SSIM >= 0.98 or stricter row-specific threshold;
  numeric contracts meet manifest tolerances; disposal returns to baseline.
- Definition of done: `npm run verify:parity` reports 100%, installed tarball
  passes the complete suite, actual browser/GPU support is published, and the
  checklist has no waiver, untracked exclusion or open parity item.

## Global Verification Commands

The final release gate runs from a clean checkout:

```powershell
cargo fmt --all -- --check
cargo check -p forge3d-core --target wasm32-unknown-unknown --no-default-features
cargo check -p forge3d-web --target wasm32-unknown-unknown
cargo test -p forge3d-core
cargo test -p forge3d-web
cargo clippy -p forge3d-core --target wasm32-unknown-unknown --no-default-features -- -D warnings
cargo clippy -p forge3d-web --target wasm32-unknown-unknown -- -D warnings
cd crates\forge3d-web
npm ci
npm run verify:parity
npm run typecheck
npm run build
npm run test:api
npm run test:package
npm run test:package-consumer
npm run test:browser
npm pack --dry-run
```

Hardware publication runs exactly the required and preflight lanes defined by
`crates/forge3d-web/docs/support-matrix.md`: branded physical Chrome/Edge,
patched Playwright-Firefox engine preflight, physical SafariDriver where the
matrix requires it, and WebKit-engine preflight. Patched Firefox is never
described as branded or physical Firefox evidence. A browser family is not
advertised until its required evidence is complete, but a missing support claim
does not remove any feature from the parity ledger.

## Objective Definition Of 100% Parity

Parity is complete only when all conditions hold:

1. The manifest covers every baseline export/registration and method family,
   every native test, example, doc feature, changelog addition and every removed
   module root named by the cleanup audit.
2. All 84 capability rows are `I` or verified `C`, and all seven `XC` rows are
   `I`; none remains `G`, `P`, `E`, `G→C` or undocumented.
3. Every row has a stable TS API or explicit internal owner, implementation,
   dependency record, automated tests, acceptance evidence, docs and an
   installed-package example or contract test.
4. Browser equivalents preserve user outcome/data fidelity while remaining
   async, cancellable, bounded and safe for browser/device lifecycle.
5. Diagnostic-only/experimental behavior is never represented as a successful
   render. Promotion requires implementation and grade-A/B evidence.
6. Visual parity meets SSIM >= 0.98 against applicable native goldens; exact
   contracts round-trip byte-for-byte; floats meet manifest tolerances.
7. Budgets, cancel, recovery, replay and disposal cover every resource owner,
   with no listener, observer, RAF, worker, allocation, cache lease or stream
   left after disposal.
8. The published npm tarball passes the complete API, package-consumer, browser,
   real-data and manifest gates.

Until all eight conditions hold, the package may publish incremental status but
must not claim complete Forge3D functional parity.
