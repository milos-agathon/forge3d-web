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
plate element rectangle to **≤1 px**. Separate horizontal metric data derives
from the exact two DejaVu files and Pillow BASIC/FreeType 2.14.3 for every Latin
glyph and supported integer size. It preserves 26.6 advance rounding, hinted
bounds, kerning accumulation and integer glyph origins instead of estimating
geometry from Canvas antialiasing. An independently generated 3,050-string corpus
covers regular/bold sizes 1–16384, all Latin codepoints, long kerning-heavy labels
and the reported `AVATAR` at 12 px: every width matches native exactly. The
63 regular title regressions at 12/20/24 px also run through the public browser
API, with exact horizontal geometry assertions. At least 97% of thresholded ink pixels must
lie within one pixel in both directions, with nonempty coverage assertions.
This raster tolerance accommodates antialiasing; it is separate from the ≤1 px
glyph/element geometry assertions and does not claim every ink pixel is identical.
Controls include wide scale labels and four rendered arrow rotations. Comparing
the 30° reference with an unrotated rendering fails the rotation threshold.
Horizontal legend dimensions retain the native contract, while its transposed
native tick coordinates are corrected and checked against the visible bar.
Complex scripts keep browser shaping rather than the native BASIC fallback.
The arithmetic follows [Pillow’s BASIC layout](https://github.com/python-pillow/Pillow/blob/12.2.0/src/_imagingft.c);
the generated hinted-bound data removes Canvas-specific bearing differences.

A real GPU test uploads `toTexture()` bytes to rgba8unorm, samples every texel in
WGSL, maps a readback buffer and compares all RGBA channels. Corrupting the input
texture changes the sampled output (negative control). The palette is delivered
through an application provider. W20 does not change T02 terrain ramp ownership.

## Verification

```sh
python -m pip install -r scripts/requirements-w20.txt
python scripts/generate-w20-native-fixture.py
python scripts/generate-w20-font-metrics.py
python scripts/generate-w20-text-oracle.py
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

The local full unit run passes **1,821 tests across 82 files**, including **140
W20 cases**. The source/dist Chromium suite has **32 cases**, including the 33
native plate cases as named steps. It covers PNG decode, JPEG transparency,
inset borders, replacement/export cycles, SVG/PDF determinism, worker/main pixel
equality, OPFS, colormap byte sources and native stop edge cases, label/vector
adapters, real MapScene terrain, device loss, and unavailable WebGPU. Pending font
loads are cancelled, made to fail with a structured error, then retried successfully.

The installed gate requires committed clean source, rebuilds WASM, packs and
installs the real tarball into a separate consumer, compiles its declarations,
and runs **16 dist cases** under self-only CSP. It serves only that installed
package. It also runs **48 workflows**: fonts/legend, title, labelled SVG and PDF
for Latin/Arabic/Devanagari in main/worker contexts for Vite root, Vite subpath
and unbundled CDN-style
versioned paths. Bundled cases serve only emitted build files. ES module workers
use Vite's `worker.format: 'es'`, consistent with the facade's W13 ESM module.
Request logs reject missing assets; no runtime source-tree resolution is allowed.

Pinned PyMuPDF independently opens all three script PDFs, extracts their actual
Unicode labels, verifies the dedicated embedded Arabic/Devanagari fonts and
nonempty text ink, and rasterizes the Latin fill/hole/line control. Fontkit keeps
the exact W00-pinned 1.1.1 shaper; its missing `regenerator-runtime@0.14.1` companion
is npm-integrity/source-digest checked, bundled into the module and shipped with
its MIT notice. Its tarball SHA/SRI and packaging/security decision are recorded
under the existing fontkit asset in the dependency lock; no shaper is substituted.
Unexpected fontkit shaping failures have a dedicated structured-error regression.
The gate writes revision, package/WASM digests, browser attachments, layout
measurements, consumer request logs and PDF results under `test-results/w20-*`.
Transparent JPEG regressions now verify white and colored transparent background
RGB, while composition still preserves alpha. The horizontal tick correction
remains an intentional fix for the native transposed-axis bug.

The earlier [installed record](w20-installed-evidence.json) is historical evidence
for `ed230e8`; it does not establish the review fixes. Current committed runs
produce new evidence, and their revision is recorded in the report.

Browser evidence here is local Chromium preflight. Hosted CI was not dispatched;
physical/branded browser release qualification remains W24. See
[cartography](cartography.md) for API contracts, adaptations, limits and ownership.
