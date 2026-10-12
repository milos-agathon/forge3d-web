# W18 verification

W18 implements M01, M02a and the M02b diagnostic contract. Typed recipes own
resource loading and execute W02-W17 layer adapters. PNG pixels come from actual
WebGPU raster/point rendering or an explicitly requested W17 tracing backend.
There is no source-derived image fallback.

## Independent native audit

The retained final native diagnostics, MapScene, style support source and 20 test
files were re-read from `a55911f021925a3264e476374ce43d1b204f1073` and compared
with `bf8db93233e5158f6d226991fc5d230832c2d806`. Exact Git blob bytes and hashes
are retained in `tests/fixtures/w18/native/` and `tests/fixtures/w18/contract.json`.
The generator executes all 22 native diagnostic factories and the native style
support function to obtain independent JSON oracles; expected values are never
made by the TypeScript implementation.

The [native coverage ledger](w18-native-test-coverage.json) names all 94 retained
test definitions: 87 W18 contracts/workflows and seven cross-task W19 cases.
W18 ports deterministic diagnostic JSON, support/failure policies, typed recipes,
CRS/source validation, LabelPlan integration, PNG output, no-op detection and
product support summaries. Style-to-vector evaluation and ZIP/bundle asset rewrite,
save/load/roundtrip are explicitly M03/M04/W19. W18 supplies their typed recipe,
validation JSON and deterministic review record. Full historical example-catalog
migration remains W23; W18 consolidates its terrain/raster, vector/labels and scalar
building workflows into the executable MapScene example.

Native migration-stage metadata-only sources and synthetic source-derived images
are replaced with decoded asset buffers and real rendering. Historical point-cloud,
vector loader, building and tiles placeholders are promoted only for exercised W12,
W15 and W16 adapters. Unavailable texture/product instancing/cache telemetry,
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
  PNG output, one-layer removal changes, point depth occlusion with front/behind
  controls, W16 tile selection, policy gates, replay/resize/disposal, priority and
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
