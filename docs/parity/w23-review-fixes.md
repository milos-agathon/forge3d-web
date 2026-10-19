# W23 review corrections

This ledger addresses the reviews of `3f11974f` and `efba9305` against
[W23](../superpowers/plans/2026-06-04-forge3d-browser-webgpu-wasm-runtime.md#w23--restore-documentation-examples-goldens-and-migration-guides).
Acceptance requirements are unchanged. Changes are confined to
`D:/forge3d-web/.worktrees/w23`, branch `codex/w23-documentation`.
Other active worktrees and branches are preserved; no subagents were used.

The earlier verification record demonstrated passing gates but overstated
regional computation coverage and stage-execution evidence. The current
record supersedes those claims rather than inheriting its verdict.

| Finding at efba9305 | Correction and check |
| --- | --- |
| High 1: shared terrain, missing or incorrect regional computations | Each of 24 examples now names its original source and actual native helpers/dependencies. Python executes unchanged helper ASTs for 29 operations; browser implementations consume inputs and compare independent expected values. Platte retains its distinct one-metre rule; PNOA uses masks/crop/sun, Helsinki uses GTFS, city examples use building/sun/flood computations. Smoke, storm, landcover, population, basin, railway and lighthouse operations have explicit controls and render dataflow. Erasing a computation or damaging expectations fails each case. Seven captured original DEM windows retain original-file and float32-window digests, CRS and bounds; remaining inputs are labeled bounded controls. |
| High 2: erased IBL/effects/rig stages passed through literal results | All migration JS/HTML enters the asset gate. Browser startup checks served program/control-JSON bytes; request-intercepted erased workflow code must fail before ready. Independent instrumentation outside workflows.js records actual IBL calls/readback, OIT/TAA history/draws and all three rig paths/clearance. Erasing observation sets fails the verdict. Live no-op controls cover ten features, including shadows, IBL, TAA, OIT and rigs. |
| Medium 1: substring misrouting | Whole-word EPT/IBL/scatter rules and native file/name ownership replace accidental accepts/depth/constructible/scattering matches. Point-cloud headings/names, temporal textures, style/city water and native SDF tests receive their proper owners. The source-context audit records 171 corrections against efba9305 in w23-routing-review.json. |
| Medium 2: self-referential provenance | Native matching scans python/src/assets as well as tests/examples/docs. MiniDEM matches its native blob. Derived assets record actual authoring generators, input hashes and recipes separately from storage history; missing derivations and substituted kernel sources fail. EPT children, material/environment goldens, labels/CRS and regional controls have concrete generators or historical kernels. Rainier names its source DEM/crop/COG conversion. W09 captures retain source kernels/parameters and explicitly disclose the missing original authoring harness. |
| Low 1: wrong tree link | The remaining wrong-repository URL is corrected. Both blob and tree links require the correct repository and resolvable Git object type. |
| Low 2: API row IDs | Fourteen dataset exports route to E06 and three PNG exports to E07; generated API map and coverage agree. |
| Low 3: disconnected quickstart/shadow checks | PNG consumes the actual viewer snapshot. Materials record the actual scene shadow delta and require visible RGB changes on a separate explicit occluding-ridge control, since a planar regional crop may cast no shadow. Suppressing shadow configuration fails that control. |
| Low 4: purported independent source contract | The contract now honestly identifies itself as a generated reviewed routing-intent lock, with a capture command and source-context audit record. It is not advertised as independent correctness proof. |
| Low 5: CRLF drift | Rainier truth JSON and fontkit.LICENSE have LF bytes. Attributes and the restore generator retain LF. |
| Low 6: untested blocked license | Browser tests first run protected style and bundle examples without an issuer/key and require blocked-license plus LICENSE_REQUIRED, before configuring the isolated test issuer. |

The original remediation also retains real triangle rendering, single-tile
native normalization, streamed COG convergence, style/preset consumption,
actual MP4 encoding, strict code-fence checks, installed-package isolation,
interactive controls, cancellation, URL revocation and resource disposal.

Exact commands, counts, digests and browser observations are recorded in
[w23-verification.json](w23-verification.json). The browser lane is Chromium
preflight. These bounded workflow migrations do not claim full publication
geography, native GPU visual parity, physical-browser qualification or W24
release completion. Historical test routes identify capability evidence,
without claiming execution of every original Python assertion. W09 historical
capture provenance does not recover its missing authoring harness.
