# W22 verification

Scope is E05. W02 retains all platform adapters and W04/W06/W08/W13/W15/W16
retain their individual codecs and denoiser. Source verification passed:
1,937 unit cases, ten W22 source/dist browser cases, the original W06
offline-denoise-v1 scene and denoiser acceptance cases, API/declaration checks,
package/infrastructure checks, and parity-manifest verification.

The W22 fixture manifest pins eight files: DEFLATE/predictor TIFF, real LAZ
with independent laspy/lazrs coordinate/color hashes, uncompressed KTX2,
upstream BasisLZ KTX2 from the dependency's exact commit, analytic RGBE/EXR,
GLB triangle and glyph PBF. Runtime tests verify each source hash, expected
decoded content and exact decoded bytes after replay through a new registry.

The quality probe uses the offline-denoise-v1 resolution (1920×1080), seed zero,
HDR color and albedo/normal/depth AOVs, and compares WebGPU output with the W06
CPU/WASM reference. The original W06 offline-denoise-v1 scene fixture is also
run afresh. Required thresholds stay SSIM gain >=0.02, MSE reduction >=20%,
converged SSIM regression <=0.005 and GPU/CPU maximum absolute error <=1e-4.

The W22 source/dist probe measured SSIM gain 0.79894, MSE reduction 98.829%,
converged SSIM regression 5.03e-14 and GPU/CPU maximum absolute error 7.75e-7.
The native runtime ledger returned from 155,340 bytes to the same baseline.
Raw per-case measurements are retained in the repository at
`docs/parity/w22-source-evidence.json`. The browser adapter redacts its name
and reports a browser-web-gpu backend; these measurements do not identify a
physical reference profile.

The real upstream BasisLZ fixture exposed two existing W04 integration bugs:
the module's initialization function was never called, and the pinned
Embind `uint32_t startTranscoding()` success flag was compared with boolean
`true`. The registry now exercises both the real WASM transcoder and its
RGBA fallback. The decoder remains W04-owned.

The installed strict-CSP gate also exposed dynamic JavaScript generation in
the upstream Embind glue. The separately digest-pinned CSP adapter replaces
those two bridges with static closures and preserves the original upstream
JS/WASM assets. The decision and local implementation/security review are
recorded at `docs/adr/2026-10-15-w22-basis-csp-glue.md` in the repository.

The installed consumer gate builds WASM and TS from a clean committed tree,
packs and installs the tarball into a separate directory, compiles a consumer
against shipped declarations and serves only installed package files under
strict CSP (`worker-src 'self'`, no CDN). It records package/WASM digests and
raw Playwright results under test-results. Local GPU runs are Chromium
preflight evidence, without extending any physical hardware/browser claim.

Reproduce with `npm run test:w22`, `npm run test:api`,
`npm run test:package-consumer:w22` and `npm run test:package`.
