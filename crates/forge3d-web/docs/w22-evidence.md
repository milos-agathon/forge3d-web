# W22 verification

Scope is E05. W02 retains platform/storage adapters; W04/W06/W08/W13/W15/W16
retain their decoders and denoiser. The review fixes are in
`docs/parity/w22-review-source-evidence.json` and
`docs/parity/w22-review-installed-evidence.json` at the repository root.
Earlier `w22-source-evidence.json` and `w22-installed-evidence.json` are historical
records of the original implementation. They did not measure the original
offline-denoise-v1 scene through the registry.

The current gate runs nine digest-pinned fixtures: predictor/DEFLATE TIFF,
RGB multi-strip TIFF with a partial final strip, real LAZ with independent
laspy/lazrs hashes, raw KTX2, upstream BasisLZ KTX2, analytic RGBE/EXR, GLB and
glyph PBF. Replay compares complete metadata and typed-array type/bytes.
Real fixture truncations and structural corruptions supplement short-header
tests; arbitrary pixel changes can remain valid input.

The original W06 `offline-denoise-v1` fixture runs unchanged scene construction,
HDR/AOV/depth checks, 1/4/16 sample ladder, denoise thresholds and 120-frame
timestamp/memory checks. Its three denoise calls go through `CodecRegistry`
in both source and dist modes and in the installed-package gate. Required
thresholds remain SSIM gain >=0.02, MSE reduction >=20%, converged SSIM
regression <=0.005 and GPU/CPU maximum absolute error <=1e-4. The separate
synthetic edge-image probe remains supplemental evidence.

Review regressions cover the HDR decoy-header allocation bypass, mutation of
all eight omitted fingerprint inputs, stale/corrupt artifact deletion, peak
persistent budgets across owners, index-write rollback on quota failure,
transient admission, and prompt caller cancellation while GPU work drains.
The parity UTF-8 regression rejects the former mojibake; the Basis adapter
build verifies both SHA-256 and SRI against the W00 lock.
Browser probes cover missing WASM/worker globals, all three W02 persistence
adapters, injected quota errors and repeated decode/replay/denoise/dispose
cycles. `--soak` selects 128 cycles instead of the default eight. These are
bounded repeat-workflow checks, not an assertion of indefinite leak freedom.
Quota errors are injected at the adapter boundary; actual origin disk quota
exhaustion is not claimed.

W04's original Full Basis claim lacked a real-transcoder regression. The
current W04 loader tests instantiate the pinned WASM under disabled string
compilation, observe initialization and integer success, check its exact RGBA
digest, and reject a custom module without `initializeBasis` with a typed
error. W08's strip reader now uses StripOffsets/StripByteCounts instead of
silently treating strips as sparse tiles. Ownership stays with those tasks.

The pristine Basis glue and separately SHA-256/SRI-pinned CSP adapter produce
identical 1,572,864-byte RGBA output. The ADR is
`docs/adr/2026-10-15-w22-basis-csp-glue.md` at the repository root.

The installed gate rebuilds WASM/TS from a clean committed tree, packs and
installs the tarball, checks declarations and serves its modules/workers/WASM
under strict CSP (`worker-src 'self'`, no CDN). Test data and the exact original
W06 HTML harness are served separately from the repository; source implementation
routes are blocked. W22 test fixtures are excluded from the tarball. The shipped
example performs decode, replay and GPU denoise with embedded input.

Evidence is Chromium preflight on this machine. The redacted adapter does not
identify either physical reference profile. Other browser families and both
physical reference profiles remain unverified.

Reproduce sequentially in `crates/forge3d-web` with
`CARGO_TARGET_DIR=C:\devin-target\forge3d-web`:

```text
npm run build:wasm
npm run build:ts
npm run prepare-dist
npm run test:unit
npm run test:w22
npm run test:api
npm run test:package
npm run verify:parity
node scripts/test-w22-package-consumer.mjs --soak
```

The installed gate requires all implementation/generated declarations committed.
