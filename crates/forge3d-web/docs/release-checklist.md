# Forge3D Web MVP Release Checklist

Run this checklist from the repository root unless a command explicitly changes
directory. The checklist mirrors the Phase 16 release gate for the browser
WebGPU/WASM MVP.

## Interactive Viewer Release Blocker

The FND-01..FND-07 shared viewer foundation is implemented substantially, but
its contract stage remains `verification-incomplete` pending portability,
physical device-loss, and current clean exact-HEAD package evidence. It must
not be promoted as support for a browser family while
`package.json#forge3d.interactiveViewer.releaseReady` is `false`. That flag may
change only after the required branded and physical exact-head release matrix
passes. This blocker does not withdraw the existing low-level
`Forge3DRuntime` MVP.

INF-00 code completion is also separate from live laboratory readiness.
`tests/infrastructure/repository-trust-policy.json`,
`hardware-matrix.json`, `browser-policy.json`, and
`runner-transient-path-policy.json` intentionally remain in pending states
until the administrator and physical-controller steps in
`docs/browser-lab-runbook.md` are evidenced. A pending policy must fail closed;
it cannot be treated as a skipped or successful physical gate.

## Clean Setup

```powershell
cd crates/forge3d-web
npm ci
cd ../..
```

## Rust And Wasm Gates

```powershell
cargo fmt --all -- --check
cargo clippy -p forge3d-core --target wasm32-unknown-unknown --no-default-features -- -D warnings
cargo clippy -p forge3d-web --target wasm32-unknown-unknown -- -D warnings
cargo test -p forge3d-core
cargo check -p forge3d-core --target wasm32-unknown-unknown --no-default-features
cargo check -p forge3d-web --target wasm32-unknown-unknown
$env:PATH = "$pwd\crates\forge3d-web\node_modules\.bin;$env:PATH"
.\crates\forge3d-web\node_modules\.bin\wasm-pack.cmd build crates/forge3d-web --target web
```

## Web Package Gates

```powershell
cd crates/forge3d-web
npm run typecheck
npm run build
npm run test:unit
npm run test:api
npm run test:infrastructure
npm run test:package
$env:FORGE3D_PACKAGE_GATE_MODE = "required"
npm run test:package-consumer
$env:FORGE3D_SOURCE_BENCHMARK_MODE = "required"
npm run test:browser
npm pack --dry-run
cd ../..
```

`npm run test:package` includes the release-hardening contract and the dry-run
package artifact contract. The dry run must include `dist/index.js`,
`dist/forge3d_web.js`, `dist/forge3d_web_bg.wasm`, `types/index.d.ts`,
`README.md`, `LICENSE`, and `LICENSE-APACHE`.

The package-consumer gate builds and packs the real tarball, records its
SHA-256, installs that absolute `.tgz` into a fresh temporary consumer, and
serves `examples/test-interactive-viewer.html` from the consumer.
The release gate refuses to attribute a dirty worktree to `HEAD`. Its complete
validated record and package association are retained under
`test-results/browser-gate/` (or `FORGE3D_EVIDENCE_DIR`) and uploaded by CI.
The gate launches Chrome against that installed copy and verifies a reported,
non-fallback WebGPU adapter, independently observed drag/wheel/touch/keyboard
interaction,
unsupported-browser UI, screenshot readback, resize, and leak-free disposal.
It then runs the frozen benchmark and passes the complete exact-tarball evidence
record through the shared fail-closed validator. It is not an HTTP-only asset
smoke test.
Hosted CI sets `FORGE3D_PACKAGE_GATE_MODE=probe` because its virtual Windows
runner may expose only a fallback adapter. That lane still builds, packs,
installs, serves, and exercises the exact tarball, but records `PROBE`, omits
the performance benchmark, and cannot satisfy release promotion. Required
release execution defaults to `FORGE3D_PACKAGE_GATE_MODE=required` and still
fails closed on fallback hardware.
Hosted CI likewise sets `FORGE3D_SOURCE_BENCHMARK_MODE=probe`: the source
browser test persists schema-valid environment and interaction evidence but
does not run or label software-renderer timing as a real-GPU benchmark.
Required source execution defaults to `required`, runs all 600 measured
samples, and rejects fallback adapters.
Release browser evidence must validate against
`tests/browser/browser-evidence.schema.json`; a required lane may not pass with
an unavailable adapter, a probe-only result, or a source-WASM digest in place
of an exact npm-tarball digest.
The required source-browser benchmark writes and attaches its complete evidence
record under Playwright `test-results/`; CI uploads that record separately.

## Release Notes

- Confirm `CHANGELOG.md` has an `Unreleased` entry for browser MVP release
  hardening.
- Confirm `docs/support-matrix.md` states browser support, unsupported
  surfaces, MIME, CORS/Range, and cache requirements.
- Confirm `README.md` links this checklist and the support matrix.
- Confirm `docs/browser-lab-runbook.md` and every checked infrastructure
  policy agree on the repository, trust epoch, controller keys, runner
  version, archive digests, protocol versions, and provisioning state.
- Confirm post-MVP features remain documented as unsupported rather than
  partially exposed through the browser API.
