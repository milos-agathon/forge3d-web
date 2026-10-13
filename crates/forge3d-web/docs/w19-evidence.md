# W19 verification evidence

Worktree: `D:/forge3d-web/.worktrees/w19`, branch `codex/w19-style-bundles`.
Implementation base: `1e561a02d306649b0947dc712c6e163c57f15d5f`.
Review corrections address the failed assessments at `8d50587` and `1a94315`.
T18, M03 and M04 are the scoped architecture rows.

The independent baseline is `bf8db93233e5158f6d226991fc5d230832c2d806`.
Twenty-two exact native source/test files are hash-pinned under
`tests/fixtures/w19/native`. Source inventory is provenance, not behavioral proof.
The generator executes 89 original native test functions, preserving their
assertions, and records API inputs/results. Eighty tests have behavioral traces
replayed by `w19-native-replay.test.ts`; the other 23 original cases have explicit
browser outcome assertions in `w19-native-equivalents.test.ts`. Nine of those
23 were also executed natively but produced no trace. The coverage JSON has an
exact test title, operations or a specific substitution rationale for every case.
The replay proves API observations, not that Python test bodies execute in JS.
The only native execution shim bypasses the W21 license check; native style,
expression, diagnostics, bundle and geometry algorithms run unchanged.

Independent references additionally cover 56 original expressions, 102 edge
observations across three contexts, 18 colors, 21 paint/context combinations,
three label mappings, twelve legacy filters and three feature mappings. A real
native saver produces `native-v2.forge3d`; its disagreeing preset/bookmark mirrors
exercise native precedence. Migration assertions check base raster/vector/label
payloads, terrain colormap, callout anchors, empty/opaque variant preset
replacement, and subsequent native-asset resaving. Replays now validate the mapped layer
settings, supplying native viewer terrain context for state-only saves.
`native-renderable.forge3d` is a second real native-saver archive with executable
PNG/TIFF bytes, base and review vectors, and supported presets. Browser tests
validate, prepare and render it; removing each raster/vector changes pixels and
its resaved archive renders identical pixels with network reads blocked. Native directory v1 and
browser recipe v1 have separate checked migration paths.

The review fixes include native Python coercions/arity, scaled text offsets,
first matching geometry-compatible layers, black default lines and native legacy
filter pass-through. The converter uses native default paint context (empty
properties, zoom 10); direct paint helpers accept explicit feature/zoom context.
No unsupported native preset field disappears: it is retained and diagnosed.

Bundles acquire referenced sprite pairs and the finite glyph inventory, retain
supplemental assets through LoadedBundle and MapScene resaves, and omit internal
marker/Blob aliases from portable manifests. Unused glyph templates stay as
metadata without blocking fill/line exports; requested missing ranges still fail
strict exports or produce blocking diagnostics. Native raster extents use the
UV extent field, subminimum native depth bias maps to the supported 0.01 minimum,
and base/review vector IDs are globally unique. Unsupported streamed
sources retain their URLs and warnings without fetching TileJSON or tiles. They
are not executable MVT content. Style support is assessed even for standalone
save/load. Disposal returns RUNTIME_DISPOSED consistently. Repeated saves do not
duplicate missing-resource diagnostics; byte-view hashing excludes backing-buffer
bytes outside the supplied view.

`w19_style_bundle.spec.ts` runs twelve workflows against source and generated dist:
covered geometry with removal controls; exact offline pixels; atomic variants;
URL/File/Blob/stream/OPFS inputs; external asset leases; genuine HTTP bundle load;
cold CacheStorage replay with network reads blocked; bounded progress, typed quota
failure and cancellation of an actual staged OPFS writer; style asset resaving;
download/file-input UI; unused glyph declarations with strict/default export pixel equality; native
asset preparation and per-layer pixel controls; and device destruction after a
successful prior render.
The device-loss check first proves last_render is non-null, then requires it to
clear and verifies active-variant recovery and released GPU owners.

The installed gate requires a clean committed checkout, rebuilds WASM and TS,
packs and installs a tarball in an independent project, and typechecks public
imports. Its server resolves every example, fixture, runtime and asset exclusively
from the installed package. The same twelve dist workflows run under hash-protected
HTML, script-src/worker-src self and the required WASM allowance. It records the
revision, tarball SHA-256, newly built WASM SHA-256, installed serving root and exit
status in `test-results/w19-package-consumer.json`.
The required CI build/contract job also runs this installed W19 gate and uploads
its revision/hash report and twelve-case Playwright report as `forge3d-web-w19-installed`.

Validation for these corrections: 1,681 unit tests in 75 files, including 419
W19 tests; 24 source/dist Chromium cases; API/declarations; package/infrastructure
contracts; parity/dependency-lock checks; and the clean installed twelve-case gate.
Exact final installed run metadata is retained in the generated report above.

`fflate@0.8.3`, its integrity and bundled MIT notice are unchanged. Evidence is
local Chromium preflight and installed-package evidence. Physical-browser
qualification and the remaining W20-W24 work are separate. Automatic Mapbox
symbols retain the native experimental/underdeveloped diagnostic.
