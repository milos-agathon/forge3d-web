# Forge3D Web

Browser-only WebGPU/WASM terrain rendering for the `@forge3d/web` npm package.

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

## Repository Scope

This repository is scoped to browser/npm/WASM delivery:

- `crates/forge3d-core`: browser-safe Rust support for error mapping, GPU
  context ownership, camera validation, terrain heightmaps, readback helpers,
  and byte-source IO.
- `crates/forge3d-web`: wasm-bindgen runtime, TypeScript facade, Vite example,
  package docs, API/package contracts, and Playwright browser tests.
- `.github/workflows/web.yml`: browser CI for wasm checks, package build,
  typecheck, and Chromium WebGPU tests.

Python wheels, PyO3 bindings, native viewers, desktop IPC, root Python tests,
and legacy examples/docs are intentionally out of scope for this repo.

## Verification

Run browser-focused checks from the repository root:

```powershell
cargo check -p forge3d-core --target wasm32-unknown-unknown --no-default-features
cargo check -p forge3d-web --target wasm32-unknown-unknown
cd crates\forge3d-web
npm ci
npm run typecheck
npm run build
npm run test:api
npm run test:package
npm run test:browser
npm pack --dry-run
```

See `crates/forge3d-web/docs/release-checklist.md` for the release checklist
and `crates/forge3d-web/docs/support-matrix.md` for browser support.

## License

Apache-2.0 OR MIT.
