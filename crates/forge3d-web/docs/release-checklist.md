# Forge3D Web MVP Release Checklist

Run this checklist from the repository root unless a command explicitly changes
directory. The checklist mirrors the Phase 16 release gate for the browser
WebGPU/WASM MVP and keeps Python/native compatibility in scope.

## Clean Setup

```powershell
cd crates/forge3d-web
npm ci
cd ../..
```

## Rust And Wasm Gates

```powershell
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --features default -- -D warnings
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
npm run test:api
npm run test:package
npm run test:browser
npm pack --dry-run
cd ../..
```

`npm run test:package` includes the release-hardening contract and the dry-run
package artifact contract. The dry run must include `dist/index.js`,
`dist/forge3d_web.js`, `dist/forge3d_web_bg.wasm`, `types/index.d.ts`,
`README.md`, `LICENSE`, and `LICENSE-APACHE`.

## Python And Native Compatibility Gates

```powershell
python -m maturin build --manifest-path crates/forge3d-python/Cargo.toml --release --out dist
python -m pip install --force-reinstall --no-deps .\dist\forge3d-1.26.0-cp310-abi3-win_amd64.whl
pytest tests/test_install_smoke.py tests/test_api_contracts.py -v --tb=short
cargo check -p forge3d-native-viewer
```

## Release Notes

- Confirm `CHANGELOG.md` has an `Unreleased` entry for browser MVP release
  hardening.
- Confirm `docs/support-matrix.md` states browser support, unsupported
  surfaces, MIME, CORS/Range, and cache requirements.
- Confirm `README.md` links this checklist and the support matrix.
- Confirm post-MVP features remain documented as unsupported rather than
  partially exposed through the browser API.
