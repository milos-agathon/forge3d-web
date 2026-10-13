Review W19 in D:/forge3d-web/.worktrees/w19 on codex/w19-style-bundles. Inspect the full diff from 1e561a02d306649b0947dc712c6e163c57f15d5f to HEAD, including corrections after the failed review at 8d505871e656c257005ebbcea85367193f830ecf. Use docs/superpowers/plans/2026-06-04-forge3d-browser-webgpu-wasm-runtime.md section W19, rows T18/M03/M04 and the browser-equivalent rationale as requirements. Do not trust completion claims or passing counts.

Use native bf8db93233e5158f6d226991fc5d230832c2d806 as the independent oracle; the source files, generator, real native archives and per-test evidence are in crates/forge3d-web/tests/fixtures/w19, scripts/generate-w19-native-fixtures.py, scripts/w19_native_replay.py and docs/w19-native-test-coverage.json. Distinguish the 80 API replay cases from 23 browser equivalents; source-symbol presence is not behavioral evidence.

Assess and reproduce:
- Native expression arity/coercion, defaults, first-match/filter behavior, em offsets and diagnosed unsupported intent.
- Real native v1/v2 migration: base_state, mirror precedence, base assets/labels, terrain colormap, empty/opaque preset replacement and preserved raw intent.
- Mandatory checksums, bounded archives, sprite/glyph acquisition, both resave paths, finite offline glyph inventory and non-executable streamed-source intent.
- Atomic variants/visibility, failed transitions, cancellation, typed quota/progress, HTTP loading, cold offline-cache replay, disposal and device loss after prior rendering.
- Clean installed-package isolation, freshly built WASM, CSP and declarations. Verify every required resource is served from the tarball.

Run npm run test:w19, test:api, test:package, verify:parity and test:package-consumer:w19 in crates/forge3d-web; rerun the full unit suite. Consult docs/w19-evidence.md for limits. Report only actionable findings with severity, file:line, reproduction and violated requirement, then PASS/FAIL for T18, M03, M04 and any unverified acceptance condition. Do not use subagents.
