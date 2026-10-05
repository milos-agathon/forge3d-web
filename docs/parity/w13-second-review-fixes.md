# W13 second inline review fixes

Follow-up to `1d7e235` on `codex/w13-labels`, in the same managed worktree.
All six supplied findings were verified against source and corrected. No
subagents were used. Native contracts remain pinned to `1f4084a`; line placement
uses the deepest `bf8db93233e5158f6d226991fc5d230832c2d806` source reference.

| Finding | Final behavior and regression evidence |
|---|---|
| 1: stale labels and repeated errors | Failed label generation commits an empty label scene and clears `getLabelReport()`. The failed revision stays empty across ten camera changes, resize and device recovery; edits or explicit `setLabels` retry. Invalid replacement also clears the previous layer. Frame errors report once per invalid state. Unit and actual-browser/installed-package probes exercise clearing, motion, replacement, repair and recovery. If committing the empty scene fails, the runtime error still propagates. |
| 2: sparse repeats disappear | If text passes the 90% fit limit but regular repeat centers contain no complete instance, render one centered instance. Tests cover distances 0, 60, 80, 95 and 200 on a 100-pixel path; a longer 360-pixel path retains three repeats. Actual source/package pixels cover the 200-pixel spacing case. Empty outlines still report `empty_glyphs`. |
| 3: feature fallback diagnostics | Flat fallback requires both a geometry type and coordinates, restoring native `placeholder_fallback` / `label invalid geometry` for a null GeoJSON geometry. Empty arrays use native truthiness and fall through to `position`/`world_pos`. Two new immutable native feature calls verify the full payloads. |
| 4: ingestion validates elevation too early | Feature ingestion checks x/y separately from compiler coordinate validation. Null z survives Point, LineString and Polygon ingestion; the point then produces compiler `invalid_geometry`. Three native feature calls and an additional compiler call preserve the validation stage. |
| 5: capture throws synchronously | Label refresh runs inside the screenshot promise. Its first invalid-state attempt rejects asynchronously; subsequent captures show the cleared scene. `setScene` device loss is routed through recovery. A runtime seam throws loss specifically during label scene commit and verifies promise rejection plus replacement-runtime replay. |
| 6: reversed text reads backwards | Reverse path traversal along with glyph tangent normalization, preserving HarfBuzz's shaped order. Forward/reversed `AB` and Arabic meshes match exactly; forward/reversed `AB` raster pixels match exactly. This intentionally corrects the visible bug shared by native `line_label.rs`; LabelPlan records, ordering and diagnostics retain their native contract. |

## Executed checks

- All 865 TypeScript tests in 50 files passed with
  `node node_modules/vitest/vitest.mjs run --maxWorkers=2`.
- The focused label/viewer run passed 173 tests, including 129 W13 tests and
  three new viewer lifecycle regressions.
- All 11 WebGPU browser checks passed: nine W13 checks plus two shared W02
  checks, including 30 create/render/loss/dispose cycles.
- The oracle generator passed all 43 original selected native tests and now
  records 51 compiler calls and 26 feature recipe calls.
- Installed tarball: all eight workflows passed; Vite-bundled shaping matched.
  Typechecking/public API, package contract and release-hardening gates passed.
- The parity gate passed 15 tests and verified 6531 records and 31 locked
  consumers with no unresolved records or dependency-lock violations.
- Seven documentation-link checks passed; `git diff --check` passed.

The first unrestricted full unit runs hit the existing five-second timeout in
native-source inventory and an IBL cache test under concurrent host load. The
two-worker rerun passed all assertions without changing test timeouts. The new
browser recovery probe initially required enabling its diagnostic test seam;
the corrected final run passed.

## Measured package evidence

[Committed package evidence](w13-package-consumer-evidence.json) records Chromium
148.0.7778.96 with no page errors or remote requests under strict CSP. Terrain
covered 2266 pixels; attach, detach and failed-label clearing changed zero bytes.
A valid label first changed 4350 total channel units, so the clearing probe is
not comparing two frames that never had a label. Camera-motion comparison to
an explicit no-label scene also changed zero bytes. Recovery kept labels empty,
repair restored the valid label, and invalid replacement cleared its pixels.
Three separately introduced invalid states produced exactly three label errors;
the deliberately simulated device loss was reported separately.

Forward `AB` covered 337 pixels and matched reversed-path pixels byte-for-byte.
The sparse repeated `ROAD` covered 219 pixels with one accepted label and no
rejections. The prior terrain-lighting negative control still differs by 39398
channel units, maximum 18; the depth-test negative control remains visible.

Final tested tarball SHA-256: `e809b0758e273b521771abe67c972758dd92f01c74a06467aae0ce70556153ca`.

## Limits

This is Windows Chromium preflight, not the FND branded-browser/hardware matrix.
No Rust source changed, so Rust/Clippy were not rerun; their prior-run evidence
and pre-existing infrastructure limits remain in
[implementation evidence](w13-implementation.md). Combined scatter/probe replay
with labels was not separately added to the browser probes. Native CRS oracles
use the established stub/fallback setup; this is not new pyproj validation.
The reversed-path correction is a documented intentional visual difference
from the pinned native implementation. Paragraph bidi, vertical text and
viewer curved/terrain-elevated line promotion remain outside the supported cases.
