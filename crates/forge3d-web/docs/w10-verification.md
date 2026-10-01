# W10 verification

Implementation covers T16, T17, P08, P09 and P10. Configuration and rendering
contracts are described in [environment and water](environment-water.md).
Verification was performed in the new `codex/w10-environment` worktree;
prior completion claims were not used as evidence.

## Independently checked behavior

- 48 UTC sun cases execute the pinned native ephemeris independently; six TV6
  density fields execute the original native generator, including terrain heights.
- Native source digests are checked against Git objects. GPU probes compile the
  original sky/cloud/water arithmetic separately from the port and require
  maximum error below 1e-3 and SSIM at least 0.98. Disabled controls fail 0.98.
- Browser sky/cloud/water RGBA goldens exercise complete depth composition;
  cloud/water disabled controls fail 0.98. These are browser regression images,
  not native full-scene image comparisons.
- Volume isolation is measured against independent per-pixel CPU ray/box
  intersection, with a contributing volume and at most one byte outside it.
- Covered terrain and general-scene geometry receive atmosphere. Tests cover
  cloud modes, shadows, seed/time determinism, foam/masks, three reflection tiers,
  half-resolution upscale, froxel interpolation, occluded rays, temporal reset,
  worker serialization, offline HDR/water guides and repeated offline capture.
- Device loss replays environment, atomic budget rejection retains the frame,
  resize preserves resources and original lighting, and clearing releases memory.
  Real sampled-texture layouts and a capped adapter verify 16-texture support.

## Local commands

- `cargo test -p forge3d-core --features webgpu`: 369 passed.
- `cargo test -p forge3d-web --lib`: 177 passed.
- `npm run test:unit`: 724 passed across 46 files.
- `npm run test:api`, `npm run test:docs`, `npm run verify:parity`: passed.
- Browser spec inventory classifier: 13 passed.
- W10 Playwright suite: 15 Chromium preflight checks and 15 stable Chrome
  checks passed; Chrome used no launch flags. Goldens were also checked without
  regeneration.

## Qualification limits

The historical native water-reflection/cloud full-scene images are not
reproduced by these fixtures. The native arithmetic probes and full browser
regression images must not be represented as that qualification. Pinned W00
reference-hardware performance and non-Chromium W10 runs remain unqualified.
Billboard clouds use one sample of the procedural slab; hybrid selects that
far-field approximation. Froxels cache fog lighting/density; bounded volumes
and clouds retain clipped ray marching. Screen reflections have screen-depth
visibility; planar reflections use existing scene LOD and omit recursive
atmosphere/water. The compositor has no default-on effects.

The clean installed-package acceptance run is recorded separately when complete.
