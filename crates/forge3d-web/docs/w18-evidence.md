# W18 verification

W18 implements M01, M02a and the M02b diagnostic contract. Typed recipes own
resource loading and execute W02-W17 layer adapters. PNG pixels come from actual
WebGPU raster rendering or an explicitly requested W17 tracing backend.
There is no source-derived image fallback.

## Independent native audit

The retained final native diagnostics, MapScene, style support source and 24 test
files were re-read from `a55911f021925a3264e476374ce43d1b204f1073` and compared
with `bf8db93233e5158f6d226991fc5d230832c2d806`. Exact Git blob bytes and hashes
are retained in `tests/fixtures/w18/native/` and `tests/fixtures/w18/contract.json`.
The generator executes all 22 native diagnostic factories and the native style
support function to obtain independent JSON oracles; expected values are never
made by the TypeScript implementation.

The [native coverage ledger](w18-native-test-coverage.json) audits all 106 retained
test definitions: 99 W18-owned assertion adaptations and seven deferred W19 cases.
This is an inventory count, not a claim that 106 native tests are fully ported.
Each entry names the web tests, tested assertion scope, browser substitutions and
deferred archive/style/catalog assertions. The ledger gate parses actual test
declarations; a nonempty file is no longer evidence of assertion coverage.
The four previously omitted P1 tiles, P2 determinism/no-op, memory and bottleneck
files now have explicit plan owners. Memory summaries belong to M02b; actual GPU
allocator enforcement remains R07/W02. Seven semantic documentation tests check
API truth, emitted diagnostic codes, links, support taxonomy and product boundaries.
W18 ports deterministic diagnostic JSON, support/failure policies, typed recipes,
CRS/source validation, LabelPlan integration, PNG output, no-op detection and
product support summaries. Style-to-vector evaluation and ZIP/bundle asset rewrite,
save/load/roundtrip are explicitly M03/M04/W19. W18 supplies their typed recipe,
validation JSON and deterministic review record. Full historical example-catalog
migration remains W23; W18 consolidates its terrain/raster, vector/labels and scalar
building workflows into the executable MapScene example.

Native migration-stage metadata-only sources and synthetic source-derived images
are replaced with decoded asset buffers and real rendering. Accepted W12 vector
and W15 scalar building adapters render actual buffers. M02b preserves the exact
point-cloud placeholder_fallback and tiles python_public_3dtiles_incomplete errors
for every MapScene recipe, including nonempty data and explicit supported intent.
MapScene integration of G02-G04 is not yet implemented and tested.
The gate was not changed. Unavailable texture/product instancing/cache telemetry,
non-albedo VT, legacy Python 3D Tiles and explicit experimental intent retain
structured blocking diagnostics. Native standalone experimental/glyph warnings
keep their original factory severity. Explicit unverified recipe paths cannot turn
those warnings into a successful render record.

## Verification commands

- `npm run test:unit`: complete unit suite, including native hash/oracle checks,
  deterministic recipes, integrity tampering, all-resource errors, cancellation,
  ownership, policies, memory, CPU trace and depth-composition negative control.
- `npm run test:api`: package-entrypoint exports, strict source/consumer types and
  public declaration snapshot.
- `npm run test:w18`: source and dist browser MapScene cases. Checks real multilayer
  PNG output, one-layer removal changes, retained M02b gates before fetch/GPU work,
  JSON camera/style/traversal/raster/lighting errors, warning-policy output,
  replay/resize/disposal, priority and
  keepout plans, device loss, cancellation after work, external F32/image/vector/
  label/OBJ resources, lighting/post-FX effects and real GPU trace hits.
- Focused W16 covered-point/picking/resize/recovery/allocation cases verify the
  shared point renderer regression boundary.
- `npm run test:package`: aggregate docs, package, browser-harness and infrastructure
  contracts. The exact infrastructure spec inventory includes W18.
- `npm run verify:parity`: M01/M02a/M02b plan/manifest consistency and inventory.
- `npm run test:package-consumer:w18`: clean committed checkout, rebuilds declarations,
  packs and installs into a separate consumer, compiles a strict consumer and runs
  every W18 dist case. Its static server permits runtime/assets only from the
  installed package and fixture/example routes from the harness; ranged fixtures
  return HTTP 206. The report binds Git revision and tarball SHA-256.

Fresh WASM was built with `CARGO_TARGET_DIR=C:\devin-target\forge3d-web`.
All browser observations are local flagged Chromium preflight evidence. They do not
qualify physical W00 reference profiles, Firefox, Safari, or the W16 decoder's
independent security review. Those release qualifications remain their existing
owners and are not closed by W18.

See [MapScene and diagnostics](mapscene-diagnostics.md) for public contracts,
limits and browser substitutions. Bundle save/load and furniture/export have their
existing W19/W20 ownership.

## Review corrections

The original reports in `docs/parity/w18-runs/` describe the superseded implementation
that prematurely rendered MapScene points/tiles and used a file-existence coverage
ledger. They do not establish current M02b conformance. Fresh repair verification
is recorded in the repository's `docs/parity/w18-review-fixes.md`.

Validation and preparation now use the same merged raster settings, including
inherited overlays and all layer options. Unknown camera and nested setting keys
and unknown lighting presets are user diagnostics before rendering. Native building
texture, cache/LOD and instancing details survive in actual MapScene reports.
Recipe byte limits honor explicit resource/recipe caps throughout construction and
JSON replay; bounded base64 scanning avoids stack overflow for large inline DEMs.
The 64 MiB, 128-layer and 16-megapixel guards are browser defaults; only the 512 MiB
memory policy is native R07 parity.
