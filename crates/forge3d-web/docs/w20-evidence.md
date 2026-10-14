# W20 implementation and verification

M05–M07 were rechecked against native `bf8db93233e5158f6d226991fc5d230832c2d806`
and the composite baseline's deleted colormap tests from `8065223^`. The
[coverage ledger](w20-native-test-coverage.json) inventories **105 native cases**:
82 Python plate/export/projection cases, all 19 Rust inline export cases, and
four historical colormap cases. Exact source bytes and per-file revision/digests
are in `tests/fixtures/w20/provenance.json`. TypeScript AST checks require real
assertion-bearing callbacks/case bodies; browser cases count executed assertions.
The 33 map-plate ports live in the browser test harness, outside the example.

The reference runner executes 80 original Python cases; only two native-extension
imports skip, and both numerical projection contracts have executable ports.
W21 licensing is stubbed only in this reference runner. Historical Lab lightness,
registry, repeatability and CVD endpoint assertions have non-skipping JS ports.
The historical CVD helper used an invalid colorspacious tuple; its endpoint
assertion uses the published Machado severity-100 deuteranomaly forward matrix.

## Independent controls

`native-oracle.json` records all 256 linear RGBA samples for each palette, 18
anchor placements, 12 geodetic scales, display gradient bytes and native SVG.
The SVG comparison checks all path/line coordinates, holes, label text and style
attributes, normalizing only path whitespace. The generic default is `sans-serif`.

`layout-oracle.json` comes from actual PIL rendering of the untouched native
classes, with verified DejaVu 2.37 regular/bold bytes and explicit BASIC layout
(to avoid platform-dependent fallback/RAQM). It records glyph metrics, individual
furniture PNGs, a composed plate and the native compositor's actual blit rectangles.
Browser tests bound every recorded glyph dimension, furniture dimension and
plate element rectangle to **≤1 px**. At least 97% of thresholded ink pixels must
lie within one pixel in both directions, with nonempty coverage assertions.
Controls include wide scale labels and four rendered arrow rotations. Comparing
the 30° reference with an unrotated rendering fails the rotation threshold.
Horizontal legend dimensions retain the native contract, while its transposed
native tick coordinates are corrected and checked against the visible bar.
Complex scripts keep browser shaping rather than the native BASIC fallback.

A real GPU test uploads `toTexture()` bytes to rgba8unorm, samples every texel in
WGSL, maps a readback buffer and compares all RGBA channels. Corrupting the input
texture changes the sampled output (negative control). The palette is delivered
through an application provider. W20 does not change T02 terrain ramp ownership.

## Verification

```sh
python -m pip install -r scripts/requirements-w20.txt
python scripts/generate-w20-native-fixture.py
npm run test:unit
npm run build:wasm
npm run build:ts
npm run prepare-dist
npm run test:api
npm run test:package
npm run verify:parity
npm run test:w20
npm run test:package-consumer:w20
```

The local full unit run passes **1,818 tests across 80 files**, including **137
W20 cases**. The source/dist Chromium suite has **26 cases**, including the 33
native plate cases as named steps. It covers PNG decode, JPEG transparency,
inset borders, replacement/export cycles, SVG/PDF determinism, worker/main pixel
equality, OPFS, colormap byte sources and native stop edge cases, label/vector
adapters, real MapScene terrain, device loss, and unavailable WebGPU. Pending font
loads are cancelled, made to fail with a structured error, then retried successfully.

The installed gate requires committed clean source, rebuilds WASM, packs and
installs the real tarball into a separate consumer, compiles its declarations,
and runs **13 dist cases** under self-only CSP. It serves only that installed
package. It also runs **24 workflows**: fonts/legend, title, labelled SVG and PDF
in main/worker contexts for Vite root, Vite subpath and unbundled CDN-style
versioned paths. Bundled cases serve only emitted build files. ES module workers
use Vite's `worker.format: 'es'`, consistent with the facade's W13 ESM module.
Request logs reject missing assets; no runtime source-tree resolution is allowed.

Pinned PyMuPDF independently opens the PDF, extracts Unicode text, checks
embedded fonts/vector paths and rasterizes fill, hole, line and text pixels.
The gate writes revision, package/WASM digests, browser attachments, layout
measurements, consumer request logs and PDF results under `test-results/w20-*`.
The earlier [installed record](w20-installed-evidence.json) is historical evidence
for `ed230e8`; it does not establish the review fixes. Current committed runs
produce new evidence, and their revision is recorded in the report.

Browser evidence here is local Chromium preflight. Hosted CI was not dispatched;
physical/branded browser release qualification remains W24. See
[cartography](cartography.md) for API contracts, adaptations, limits and ownership.
