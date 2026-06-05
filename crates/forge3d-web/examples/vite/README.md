# Forge3D Web Vite Example

This example consumes the package entrypoint exactly as an application would:

```ts
import { Forge3DRuntime } from "@forge3d/web";
```

## Run

```bash
npm install
npm run build
```

Use `npm --prefix examples/vite run build` from `crates/forge3d-web` when
checking the example through the package build script.

## Browser Requirements

The example requires browser WebGPU support through `navigator.gpu`. If WebGPU
is unavailable, the example replaces the canvas with a short unavailable
message instead of trying to create the runtime.

When serving a production build, the generated `.wasm` asset must be available
with `Content-Type: application/wasm`. Cross-origin deployments must preserve
normal CORS behavior for application assets and any terrain URL sources.

