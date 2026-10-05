# W13 inline review fixes

Follow-up to `9b45195` in the same `codex/w13-labels` worktree. All 12 supplied
findings were checked against code and immutable native sources, then corrected.
No subagents were used. Native references are `1f4084a` for Python contracts and
`bf8db93233e5158f6d226991fc5d230832c2d806:src/labels/line_label.rs` for placement.

| Finding | Correction and regression evidence |
|---|---|
| 1: viewer terrain lighting | Internal label scenes retain both runtime default lights. `viewerReview` compares a nonblank terrain before attach, after empty attach and after detach byte-for-byte; the original one-light state is an independent negative control. |
| 2: preset casing | Curved and configured-line checks lowercase presets; additional native oracle calls exercise `Curved`, `CURVED` and `Road`. |
| 3: terrain line compiler | Removed the viewer-only experimental rejection from `LabelPlan`. Configured native line plans remain accepted with their supplied samples; the canonical manifest and guide distinguish this from the experimental viewer API. No automatic line-vertex elevation is claimed. |
| 4: terminal label errors | Frame/recovery label refresh reports errors through `onError`, retaining the last GPU scene/report and the ready viewer. Repeated frames do not repeatedly report the same invalid state; edits retry. Actual browser/package checks overflow the label budget and then remove the invalid label successfully. Runtime render/device errors retain their existing handling. |
| 5: line glyph placement | Both center/along modes sample each shaped glyph's advance midpoint, normalize its local tangent and reject text wider than 90% of screen path length. Tests exercise a bend, both modes, fit rejection, reverse direction, replay and picking. |
| 6: rejection reasons | Off-screen and keepout filtering occur before collision eligibility; reports preserve `outside_view` and `keepout_region`. Empty outline/control-only text retains `empty_glyphs`. |
| 7: sampler no data | Null/undefined sampler results no longer dereference missing objects. Native feature ingestion omits empty samples; point compilation gives `terrain_occluded` and `placeholder_fallback`. Additional native and JS probes cover both paths. |
| 8: tabs | Tabs expand to four spaces, with original source cluster indices; CRLF controls are not passed as missing-glyph outlines. Real HarfBuzz tests verify width, empty space outlines and nonzero glyph IDs. |
| 9: large polygons | Bounds and visual-center distances use loops rather than spread arguments. A 200000-vertex polygon compiles successfully. |
| 10: feature adaptation | Supports flat native geometry records, case/whitespace-equivalent CRS identifiers and native string conversion of null field values. Real changes of CRS still require a transform adapter. Additional native feature oracles verify the payloads. |
| 11: public diagnostics | API-specific empty line/callout diagnostics precede invalid-path checks; `none` terrain mode and whitespace-only text preserve native creation semantics. Null coordinates remain invalid rather than becoming zero. |
| 12: depth test validity | The occluder is committed first and glyphs drawn afterward. The hidden/capture checks require depth occlusion; disabling label depth testing is a visible negative control. |

## Executed checks

- 847 TypeScript tests passed, including 114 W13 tests.
- All 10 browser checks passed: eight W13 WebGPU checks (source and dist included)
  and two shared W02 runtime checks, including 30 recovery/disposal cycles.
- All 43 original selected native Python tests passed; the generator now records
  50 compiler calls and 21 feature recipe calls, including review probes. Both
  fixtures are byte-identical across two different Python hash seeds.
- API/typechecking, release hardening, package contract and seven documentation
  checks passed. The modified preflight classifier passed 13 tests. The parity
  gate passed all 15 tests and verified 6531 records with no unresolved records
  or dependency-lock violations.
- The installed tarball passed all seven workflows under strict CSP with no
  remote requests or page errors; the Vite-built consumer matched shaping.

The committed [package evidence](w13-package-consumer-evidence.json) records
Chromium 148.0.7778.96, 2266 covered terrain pixels, zero changed bytes after label
attach/detach, a one-light negative-control difference of 39398 total channel
units (maximum 18), and 1918 visible glyph pixels when depth testing is disabled
versus zero when hidden with depth testing. The viewer remained `ready` after
one label error, retained its report and recovered after removing the bad label.

Final tested tarball SHA-256: `f0c48085f9795a74b264401033262505c6f6611b17ebf6c5f9410d3bbc8fefca`.

## Limits

This is Windows Chromium preflight, not the FND branded-browser/hardware matrix.
No Rust source changed in this follow-up; the earlier 80 core/183 web Rust test
results remain prior-run evidence. The previously reproduced infrastructure
failures and strict Clippy warnings remain documented in
[implementation evidence](w13-implementation.md). The native ordering-key
float-spelling exception is unchanged. Paragraph bidi, vertical typography and
viewer terrain-elevated/curved line promotion remain outside the supported cases.
