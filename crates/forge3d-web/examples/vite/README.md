# Forge3D Web Vite Example

This example consumes the package entrypoint exactly as an application would:

```ts
import { Forge3DRuntime, TerrainDataset } from "@forge3d/web";
```

## Terrain Datasets

`src/main.ts` builds a deterministic 65x65 DEM and exercises all three
`TerrainDataset` source modes:

- `TerrainDataset.fromArray` with a direct `Float32Array` of little-endian
  f32 elevation samples in row-major order.
- `TerrainDataset.fromSource` with a `File` containing the same f32le bytes.
- `TerrainDataset.fromSource` with a fetched URL (a `Blob` object URL; the
  dataset pipeline fetches it like any other URL).

Heights are meters, `spacing` is the physical cell size in meters, and
`nodata`/`NaN` marks invalid samples. The example renders the dataset with
height AO and sun visibility enabled, then exercises CPU analysis
(`slopeAspect`, `query`), `readTerrainHeights`, and GPU
`computeTerrainAnalysis`, logging the results.

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

