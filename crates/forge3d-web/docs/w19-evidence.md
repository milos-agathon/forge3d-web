# W19 verification evidence

The implementation starts at `1e561a02d306649b0947dc712c6e163c57f15d5f`
and is developed on `codex/w19-style-bundles` in a fresh worktree. Prior completion
claims are not used as acceptance evidence. T18, M03 and M04 are the scoped rows.

The independently executed monolithic baseline is
`bf8db93233e5158f6d226991fc5d230832c2d806`. Nineteen exact source files are retained
under `tests/fixtures/w19/native`; their SHA-256 digests and 103 named original
tests are in `tests/fixtures/w19/native-contract.json`. The generator executes
56 native expressions and 18 native colors without executing the web evaluator.
`w19-native-contract.test.ts` compares those reference outputs and checks source
digests. Native directory v1/v2 migration, mirrors, variants, raw-state retention
and missing-asset diagnostic behavior are tested directly. Browser v1 migration
is a separate versioned recipe adapter. Native CLI flags map to browser save/load
inputs, filename/Blob output and sinks; browser parity does not expose a CLI.

The implemented APIs and boundaries are in [styles and bundles](styles-bundles.md).
`w19-style-bundle.test.ts` covers parser/filter/color/geometry mapping, expression
semantics, checksums, undeclared files, ZIP limits/duplicate names, deterministic
snapshots, glTF dependency rewrite, native and browser migration, blocked reports,
pure review state, candidate failure, cancellation and asset leases.

`w19_style_bundle.spec.ts` runs the same seven workflows against both source and
generated `dist`: covered geometry with independent layer-removal controls,
pixel-exact offline replay, atomic variant/visibility changes, URL/File/Blob/
ReadableStream/OPFS, repeated disposal, external-resource rewrite and verified
sprite/glyph assets, saved LabelPlans/fonts and active-variant replay after actual
WebGPU device destruction. Geometry coverage is asserted so two empty renders cannot
pass a comparison. GPU owners are recreated for renders; replay uses retained
validated state instead of depending on a previous device. W18 regression tests
continue to exercise their pre-existing cancellation and lifecycle contracts.

The installed consumer creates an npm tarball from a clean committed checkout,
installs it into an independent temporary project, typechecks public imports and
serves only installed `dist`/assets plus the example. Its HTML is protected by a
computed script hash, `script-src 'self'`, `worker-src 'self'`, and the WebAssembly
allowance; no dependency CDN or Blob worker is permitted. The seven `dist` workflows
then run through that server. Results record the exact revision, tarball SHA-256,
installed directory and exit status in `test-results/w19-package-consumer.json`.

Fresh local gates run for this work:

- full WASM build and TypeScript declarations;
- full unit suite, plus focused reruns after lifecycle and migration corrections;
- API snapshot/emitted facade, documentation, infrastructure and package contract;
- Vite consumer example build;
- source/generated-dist Chromium browser workflows;
- clean installed tarball consumer with the same browser workflows;
- parity manifest and exact dependency-lock validation.

`fflate@0.8.3` matches the W00 version and npm integrity. Its module and MIT notice
ship in `dist/vendor` and have package asset-manifest SHA-256 entries. The npm
advisory query for this checkout returned no `fflate` advisory. Existing advisories
in unrelated test/build dependencies are outside W19's dependency change.

This evidence is local Chromium preflight and installed-package evidence. It does
not make physical-browser support claims or claim closure of the remaining W20-W24
capabilities. Automatic Mapbox symbol rendering retains the exact native
underdeveloped diagnostic. Unsupported native preset/asset intent remains
diagnostic while original data stays available in the migrated state.
