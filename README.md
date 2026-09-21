# Forge3D Web

Browser-delivered WebGPU/WASM rendering for the `@forge3d/web` npm package. The
checked-in runtime currently provides the terrain foundation; the repository's
functional target is the complete Forge3D capability baseline.

## Package

The browser package lives in `crates/forge3d-web`. It ships an ESM JavaScript
facade, generated WebAssembly assets, and hand-authored TypeScript declarations.

```ts
import { Forge3DRuntime } from "@forge3d/web";

const canvas = document.querySelector("canvas") as HTMLCanvasElement;
const runtime = await Forge3DRuntime.create(canvas, {
  width: 640,
  height: 360,
  devicePixelRatio: window.devicePixelRatio
});

runtime.setTerrain({
  width: 2,
  height: 2,
  heights: new Float32Array([0, 0.4, 0.2, 0.8])
});
runtime.render();
```

## Delivery Format And Functional Target

This repository publishes browser/npm/WASM artifacts:

- `crates/forge3d-core`: browser-safe Rust algorithms, data models, resource
  owners, and GPU support.
- `crates/forge3d-web`: wasm-bindgen runtime, TypeScript facade, package docs,
  examples, API/package contracts, and browser tests.
- `.github/workflows/web.yml`: wasm, package, parity, and browser verification.

Python wheels, PyO3/NumPy bindings, native executables, desktop IPC, and CMake
are not shipped delivery mechanisms. Native Forge3D outcomes remain in the
functional target and must be implemented through browser-native APIs or an
explicitly tested equivalent.

The [functional-parity plan](docs/superpowers/plans/2026-06-04-forge3d-browser-webgpu-wasm-runtime.md#exhaustive-parity-matrix)
and [composite manifest](docs/parity/forge3d-composite-baseline.json) map every
active capability to a matrix row and W00-W24 owner. Explicit retirements and
product boundaries are kept in the plan's
[tombstone ledger](docs/superpowers/plans/2026-06-04-forge3d-browser-webgpu-wasm-runtime.md#truthfulness-lifecycle-and-tombstone-ledger).
Current `P`, `G`, `E`, and `G→C` rows are feature gaps, not exclusions. See the
[functional-parity goals spec](docs/superpowers/specs/2026-06-05-forge3d-browser-webgpu-wasm-migration-goals.md)
for the status vocabulary.

## Verification

Run browser-focused checks from the repository root:

```powershell
cargo check -p forge3d-core --target wasm32-unknown-unknown --no-default-features
cargo check -p forge3d-web --target wasm32-unknown-unknown
cd crates\forge3d-web
npm ci
npm run verify:parity
npm run typecheck
npm run build
npm run test:api
npm run test:package
npm run test:browser
npm pack --dry-run
```

See `crates/forge3d-web/docs/release-checklist.md` for the release checklist
and `crates/forge3d-web/docs/support-matrix.md` for browser support.

Chromium support remains evidence-bound. The six configured primary rows cover
stable Chrome on exact Windows Intel Iris Xe, Apple M2 macOS, Linux Intel Iris
Xe GNOME Wayland, and Linux RTX 3070 GNOME Wayland hardware, plus stable Edge
on the exact Windows and Apple M2 assets. They remain `NOT_PROVEN` until the
closed physical matrix produces the immutable release's generated
`chromium-support.md`. Edge Linux is conditional/P2; Intel Mac, AMD/Linux,
unlisted hardware, non-Wayland Linux, derivative brands, Beta, and preflight
remain outside primary support.

## License

Apache-2.0 OR MIT.
