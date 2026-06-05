# Contributing to forge3d

## Development Setup

1. Install Rust from <https://rustup.rs>.
2. Clone the repo: `git clone https://github.com/milos-agathon/forge3d`
3. Install the Rust wasm target: `rustup target add wasm32-unknown-unknown`.
4. Install Node.js 20.19 or newer.
5. Install the browser package dependencies: `cd crates/forge3d-web && npm ci`.

## Running Tests

```powershell
cargo fmt --all -- --check
cargo check -p forge3d-core --target wasm32-unknown-unknown --no-default-features
cargo check -p forge3d-web --target wasm32-unknown-unknown
cargo test -p forge3d-core
cd crates\forge3d-web
npm run typecheck
npm run build
npm run test:api
npm run test:package
npm run test:browser
```

## Code Style

- Rust: run `cargo fmt` and keep browser/core wasm checks clean when touching Rust code.
- TypeScript: keep `types/index.d.ts`, `src-ts/index.ts`, and the API snapshot aligned.
- Docs: keep browser package docs aligned with `@forge3d/web` behavior.

## Pull Requests

- Keep changes scoped to one feature or fix.
- Include tests for public API changes.
- Update docs when behavior or packaging changes.
- Do not revert unrelated user work in the tree.
