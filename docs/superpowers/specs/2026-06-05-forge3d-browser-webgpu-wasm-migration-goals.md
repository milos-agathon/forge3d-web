# Forge3D Browser WebGPU/WASM Functional-Parity Goals

Source audit: `docs/superpowers/audits/2026-06-05-forge3d-web-browser-only-removal-candidates.md`

Created: 2026-06-05
Revised: 2026-09-21 for the functional-parity target

## Purpose

This spec records the active objective for `@forge3d/web`: browser/npm/WASM is
the delivery format, while 100% Forge3D capability parity is the functional
target. The [functional-parity plan](../plans/2026-06-04-forge3d-browser-webgpu-wasm-runtime.md#exhaustive-parity-matrix),
the [composite manifest](https://github.com/milos-agathon/forge3d/blob/main/docs/parity/forge3d-composite-baseline.json), and its
[schema](../../parity/schema.json) are the authoritative scope contract.

## Delivery Format

The active workspace members remain:

- `crates/forge3d-core`
- `crates/forge3d-web`

The published product remains an ESM npm package with generated WebAssembly,
hand-authored TypeScript declarations, browser WebGPU rendering, and browser IO.
Python wheels, a PyO3/NumPy ABI, maturin, CMake, native executable packaging,
desktop windows, and stdin/TCP process control are not shipped delivery
mechanisms. Their user-visible outcomes are not excluded: they map to browser
APIs and equivalents E01-E07 in the parity matrix.

## Functional Target

Every native capability in the composite baseline must have exactly one tracked
disposition:

1. An active capability is implemented directly or through the browser
   equivalent named by its R/C/T/P/V/G/M matrix row and W00-W24 owner.
2. A retired, diagnostic-only, or intended-but-unverified API is recorded in the
   [truthfulness and tombstone ledger](../plans/2026-06-04-forge3d-browser-webgpu-wasm-runtime.md#truthfulness-lifecycle-and-tombstone-ledger)
   and must not be advertised as successful rendering.
3. WebGL fallback and Node rendering are explicit browser product boundaries,
   not untracked exclusions from native parity.

Deleting a native source path does not delete its behavior from the target.
Python syntax, the PyO3 ABI, native windowing, and filesystem-path signatures do
not need to be reproduced when a tested browser-native API preserves the user
outcome.

## Truthful Status Categories

- **Delivery-format exclusion** identifies a packaging or process mechanism that
  is not shipped. It never removes the mechanism's observable outcomes from the
  parity target.
- **Tombstone** identifies an explicitly retired, diagnostic-only, or
  intended-but-unverified contract recorded by the manifest. A tombstone is not
  a feature gap or a support claim.
- **Feature gap** is any matrix row in `P`, `G`, `E`, or `G→C`. It remains linked
  to its capability ID, implementation task, tests, and acceptance criteria
  until it reaches verified `I` or `C` status.
- **Browser support status** is evidence for a browser/OS/GPU lane. `NOT_PROVEN`
  does not imply feature removal and must never be presented as `Supported`.

## Active Artifacts

| Area | Required artifacts |
|---|---|
| Core | `crates/forge3d-core/Cargo.toml`, `src/**`, browser-safe algorithms, data models, resource owners, and GPU builders |
| Web package | `crates/forge3d-web/Cargo.toml`, `src/**`, `src-ts/**`, `types/index.d.ts`, package metadata, docs, examples, and tests |
| Parity evidence | `docs/parity/**`, `crates/forge3d-web/tests/parity/**`, and the authoritative parity plan |
| CI | `.github/workflows/web.yml` and the protected physical-browser workflows referenced by the support matrix |
| Repository docs | Root/package READMEs, this spec, the support matrix, release checklist, changelog, contributing and security guidance |
| Packaging hygiene | Workspace manifests and lockfiles, root licenses, `.gitattributes`, and `.gitignore` |

## Historical Phases

Phases 1 through 16 remain evidence for the browser split, packaging, native
contract reconciliation, and release hardening. The 2026-06-05 deletion removed
source and delivery artifacts; it did not establish a permanent functional
exclusion. The composite baseline recovers the final contract, deepest shipped
semantics, historical removals, and current browser-only behavior.

## Current Acceptance Criteria

- Browser/npm/WASM remains the only published delivery format.
- Every active native outcome is present in the composite manifest with one
  capability ID and one owning task.
- Root/package READMEs, the support matrix, and the release checklist distinguish
  delivery-format exclusions, tombstones, feature gaps, and browser evidence.
- Every documented current feature gap links to its parity row and owning task.
- Release hardening rejects untracked parity exclusions and browser support
  claims without required evidence.
- `npm run verify:parity` rejects plan/manifest drift, unmapped inventory, blank
  ownership/evidence/tests, and incomplete fixture or hardware contracts.
- Complete Forge3D functional parity is not claimed while any active row remains
  `P`, `G`, `E`, or `G→C`, or while any cross-cutting constraint is incomplete.

## Verification Commands

```powershell
cargo check -p forge3d-core --target wasm32-unknown-unknown --no-default-features
cargo check -p forge3d-web --target wasm32-unknown-unknown
cargo test -p forge3d-core --features gpu
cargo test -p forge3d-web
cargo clippy -p forge3d-core --target wasm32-unknown-unknown --no-default-features -- -D warnings
cargo clippy -p forge3d-web --target wasm32-unknown-unknown -- -D warnings
cd crates\forge3d-web
npm ci
npm run verify:parity
npm run typecheck
npm run build
npm run test:api
npm run test:package
npm run test:package-consumer
npm run test:browser
npm pack --dry-run
```

Generated outputs from these commands are local build/test artifacts rather than
parity source of truth.
