# W12 verification

T12, P12 and V01–V04 have public APIs, runtime implementations, declarations,
documentation, examples and unit/browser/installed-package acceptance gates.
The implementation was checked against the historical sources rather than the
previous task ledger. The 18 source files in `tests/golden/w12/native` retain
their original bytes and SHA-256 hashes from
`bf8db93233e5158f6d226991fc5d230832c2d806`.

| Row | Implementation and behavior |
| --- | --- |
| T12 | Terrain-aware point, line and polygon topology; bilinear displayed elevation, terrain-spacing subdivision and depth bias; shared visible color and pick geometry. |
| P12 | Premultiplied standard alpha, native weighted-blended weight/reveal resolve, negotiated dual-source blending, and an observable WBOIT fallback. |
| V01 | Stable mutable layer handles, six point shapes, atlas tiles with alpha and isolated filtering, pixel LOD, AA polylines with three caps and joins, concave polygon holes and graphs. |
| V02 | Closed polygon prisms, GPU projection/extrusion/culling, stable indirect compaction and a matching deterministic CPU implementation. |
| V03 | Shared coverage and depth tests across color, full uint32 ID, world-position, depth and capture AOV passes; premultiplied resolve and HDR post-FX integration. |
| V04 | Async point/rectangle/lasso rich hits; bounded terrain ray queries; numeric ID ordering, cancellation and disposal; pointer events, named selection, hover, tint, outline, glow and pulse. |

`tests/playwright/w12_vector.spec.ts` contains eight tests. Both local Chromium
and installed Chrome pass them on Windows. Covered-image assertions prevent
blank-frame comparisons. The probes check exact CPU/GPU IDs and at most one
RGBA8 code-value difference, all shape/cap/join combinations, invisible atlas
tiles and LOD, frustum rejection, ID preservation after edits, rich queries,
selection, terrain drape, HDR capture, resize, device-loss replay, 30 allocation
replacement cycles and budget rejection without changing the committed state.
The dual-source test covers the available hardware path; an adapter override
also exercises the unavailable-feature fallback in a real browser.

The installed-tarball gate runs these probes against emitted `dist` modules and
WASM in a separate npm consumer, including a real module worker and offscreen
renderer. It verifies that no source TypeScript URLs are requested. Evidence
includes the exact Git revision and tarball digest and is saved under
`test-results/w12-package/evidence.json`. The gate requires a clean committed
worktree. The Luxembourg example renders all 2,035 original rail paths (23,277
positions) from the native GeoPackage; its synthetic demonstration relief is
identified in the UI because the original example's DEM was an external input.
The picking example exercises pointer selection and visible-feature lasso.

Validation also passes the complete TypeScript suite (768 tests), the core
WebGPU suite (379 tests), the web runtime suite (189 tests), public API and docs
checks, and the seven inherited W11 browser regressions. The generated parity
manifest references the actual W12 sources and gates while retaining the frozen
baseline inventories.

Reproduce from `crates/forge3d-web`:

```powershell
$env:CARGO_TARGET_DIR = 'C:\devin-target\forge3d-web'
npm run build:wasm
npm run test:w12
npm run test:package-consumer:w12
npm run test:unit
npm run test:api
npm run verify:parity
python scripts/generate-w12-native-fixtures.py --check
cargo test -p forge3d-core --features webgpu
cargo test -p forge3d-web
```

This is W12 acceptance on the tested local browsers. It does not qualify the
separate release hardware matrix. Edge could not launch because its executable
is not installed; Firefox, Safari and WebKit were not qualified here. Clippy
runs successfully with inherited warnings, but strict `-D warnings` stops on
existing warnings outside the W12 modules.
