# W13 implementation and evidence

Scope: V05, V06a, V06b and V07 from the browser runtime plan. Implementation
was made in a new managed worktree and branch `codex/w13-labels`, starting at
`bdda8696fe714bc5b812189d0ec1feff626c5420`. Prior W13 completion claims were not
used. Existing linked worktrees and local branches were removed as requested;
the primary checkout is detached. No subagents were used.

The [inline review follow-up](w13-review-fixes.md) records all 12 corrections
and their independent controls. The [second review follow-up](w13-second-review-fixes.md)
records six subsequent corrections, including clearing invalid viewer labels and
readable reversed paths. The [third review follow-up](w13-third-review-fixes.md)
restores camera/viewport retries and separates caller errors from frame callbacks.

## Behavior and native evidence

- Public label manager/layer with stable IDs, typed creation/removal diagnostics,
  mutable native-default styles/flags, zoom/depth/horizon controls, picking,
  snapshots, explicit ownership and scene/viewer/session integration.
- Real glyph outline triangles use existing world/overlay pipelines and capture
  targets. Legacy text rectangles and overlays retain their no-vertex paths.
  No sampled texture binding or shared terrain shader was added.
- HarfBuzzJS 1.6.0 with immutable Noto Latin/Arabic/Devanagari assets, actual
  coverage/fallback, kerning, ligatures, joining, complex clusters, metrics,
  multiline, callout leaders, underline, halos and rotation.
- Spatial collisions and the native seeded f32 greedy/annealing optimizer;
  deterministic priorities and keepouts in LabelPlan.
- Native feature/row/style ingestion, expression subset, required terrain
  sampling and a CRS-transform adapter. W14 supplies the transform and W18
  consumes the label-only recipe and validation summary; neither whole task is
  claimed here.
- The [canonical case manifest](label-case-contract.json) is compiled into the
  TS registry. Curved/viewer-elevated line cases and unprepared complex script plans
  retain typed native diagnostics. Supported repeated paths, sampled terrain
  points and prepared complex scripts render. Experimental failures allocate
  no phantom successful IDs.

The deepest Rust CPU label modules were ported from
`bf8db93233e5158f6d226991fc5d230832c2d806`. Native public/plan contracts were
read and executed from `1f4084af428dc699bdcd108b029736cb73903926`.
[Coverage](w13-native-test-coverage.json) maps 87 definitions in 30 native label
files to browser ports, including the canonical TestLabelBindings proxy.
`generate-w13-native-oracles.py` executes 43 original native tests and records
51 compiler and 26 feature recipe calls, including additional review probes. Browser tests compare complete native
outputs except Python float spellings inside ordering-key JSON strings; numeric
values compare at 1e-9, with signed zero normalized. No accepted/rejected order,
ID, candidate, coordinate, score, diagnostic detail or reason is omitted.

The native coverage gate reads 30 verbatim test snapshots from
`crates/forge3d-web/tests/golden/w13/native`, checks the original SHA-256 for
all 87 definitions and verifies the mapped browser ports. The coverage generator
extracts these bytes from the pinned Git commit; the gate requires no historical
Git objects in CI's shallow checkout. Required Windows CI also runs the W13
installed-tarball and Vite consumer workflow.


## Reproducible commands

From the repository:

```powershell
$env:CARGO_TARGET_DIR='C:\devin-target\forge3d-web'
cargo fmt --all -- --check
cargo test -p forge3d-core --lib
cargo test -p forge3d-web --lib
cargo check -p forge3d-web --target wasm32-unknown-unknown
python scripts/generate-w13-native-oracles.py
python scripts/generate-w13-coverage.py
```

From `crates/forge3d-web`:

```text
npm run build:wasm
npm run build:ts
npm run prepare-dist
npm run test:api
npm run test:unit
npm run test:w13
npm run test:release-hardening
npm run verify:parity
npm run test:infrastructure
node tests/api/package-contract.mjs
npm run test:package-consumer:w13
npm run build:example
```

The full parity and dependency-lock gate passed with 6,531 mapped records and
zero unresolved items or lock violations. The complete TypeScript suite passed 866 tests, including 129 W13 tests, with
`node node_modules/vitest/vitest.mjs run --maxWorkers=2`. Rust core passed 80 tests (31 label tests), and the web crate passed 183 tests. Eleven W13 WebGPU tests and two shared W02 runtime/lifecycle regressions passed. The W13 tests cover source and dist rendering, independent Canvas
outline comparison including holes and a blank negative control, depth
occlusion, capture, resize, replay, session copying, viewer edits/device recovery,
font lifetime and exact experimental results. They assert nonblank pixels and
resource release. The installed-consumer gate packs and installs the actual
package, typechecks its exports, serves a strict CSP, rejects page errors and
remote requests, runs every workflow, and compares a Vite-built consumer's
shaping hash with the directly served tarball. Its digest, browser version,
metrics and resource reports are saved in the ignored
`crates/forge3d-web/test-results/w13-package-consumer.json`. The final run is
also preserved in [committed package evidence](w13-package-consumer-evidence.json).

A fresh staged asset export with `core.autocrlf=true` also preserved every
pinned font, shaping and license hash. Git attributes prevent byte conversion
of those assets on Windows.

## Limits of the evidence

Verification uses local Windows Chromium preflight with actual WebGPU. It does
not close the separate FND branded-browser/hardware release matrix. Paragraph
bidi and vertical typesetting are not advertised by this horizontal label API.
SVG/PDF file generation is owned by W20; label export payloads are compiler
records, with unsupported backends returning placeholder diagnostics.

Strict `cargo clippy ... -- -D warnings` encounters existing warnings in
non-W13 codecs, offline, lighting, memory, resources and environment modules.
Warnings introduced by the new label port were repaired. The default lint run,
Rust tests and WASM check are reported separately; the strict lint result is not
represented as passing. The full repository parity manifest still tracks other
unfinished tasks, independently of the W13 rows.

See the package's [label guide](../../crates/forge3d-web/docs/labels.md) for the
public runnable workflow and exact support boundaries.

The infrastructure suite passed 605 tests, failed four, and skipped one. All
four failures reproduce in the unchanged primary checkout at the base commit:
three Windows symlink `EPERM` failures in Firefox profile/runner distribution
tests and one Bash workflow-selector test. The modified spec-registration
classifier passed all 13 tests. These infrastructure failures are recorded
separately from the passing W13 gates.
