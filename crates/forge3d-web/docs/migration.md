# Migrate Python workflows to the browser

Install `@forge3d/web` in an ESM application and serve it over HTTPS or localhost.
The browser owns the canvas, events, byte sources and downloads. Rendering and
decoding run in WebGPU/WASM; Python, filesystem paths and a viewer subprocess are
replaced with typed inputs and asynchronous operations.

The [API migration map](python-api-map.md) covers all 220 final root exports.
The [feature index](features.md) includes all 84 capabilities and seven browser
constraints. [Example migrations](examples.md) link all 54 final example assets
to executable workflows. [Native documentation](native-documentation.md) retains
the 88 original assets and 53 pages. The [coverage explanation](w23-evidence.md)
states exactly what these mappings prove.

## Height arrays, cameras and PNG output

`numpy.float32` height arrays become row-major `Float32Array` values. Keep physical
spacing and CRS metadata with the array. Coordinate triples use Y for height and
XZ for the ground plane. A native path becomes a URL, `File`, `Blob` or
`ArrayBuffer`; a PNG output becomes a `Blob`. Always dispose resource owners.

```ts checked
import { Forge3DRuntime, TerrainDataset } from '@forge3d/web';

export async function terrainSnapshot(canvas: HTMLCanvasElement): Promise<Blob> {
  const dataset = TerrainDataset.fromArray({
    width: 2, height: 2,
    heights: new Float32Array([0, 0.4, 0.2, 0.8]),
    spacing: [1, 1], crs: 'LOCAL', colormap: 'terrain',
  });
  const runtime = await Forge3DRuntime.create(canvas, {
    width: 320, height: 200, devicePixelRatio: 1,
  });
  try {
    runtime.setTerrain(dataset.toTerrainInput());
    runtime.setCamera({ position: [2, 3, 4], target: [0, 0.3, 0],
      up: [0, 1, 0], near: 0.1, far: 100, fovYDegrees: 45 });
    runtime.render();
    return await runtime.screenshot();
  } finally {
    runtime.dispose();
  }
}
```

## PNG and NumPy utilities

Replace `numpy_to_png(path, array)` with `arrayToPng({width, height, channels,
data})`. Replace `png_to_numpy(path)` with `await pngToArray(source)`. The result
contains RGBA8 bytes, including RGB values under transparent pixels.

```ts checked
import { arrayToPng, pngToArray } from '@forge3d/web';

export async function pngRoundTrip() {
  const data = new Uint8Array([255, 80, 0, 255, 12, 34, 56, 0]);
  const blob = await arrayToPng({ width: 2, height: 1, channels: 4, data });
  const restored = await pngToArray(blob);
  if (!restored.data.every((value, index) => value === data[index])) {
    throw new Error('RGBA bytes changed');
  }
  return blob;
}
```

## Viewer, notebooks and input

`open_viewer_async`, IPC commands and notebook widgets migrate to
`Forge3DViewer`, DOM controls, `Forge3DMessageClient`, `createNotebookAdapter`
and `defineForge3DElement`. Viewer runtime options belong under `runtime`.
`Forge3DWorkerRenderer` proxies input to an `OffscreenCanvas` worker. Borrowed
WASM views have explicit invalidation rules; copy a view before retaining it
across memory growth, disposal or transfer. See [browser APIs](browser-api.md).

## Recipes, assets and offline bundles

Use `MapScene` for a validated recipe. List every layer and resource before
rendering. `saveBundle`/`loadBundle` and `MapScene.saveBundle`/`loadBundle`
replace `.forge3d` paths with integrity-checked Blobs and browser byte sources.
Styles diagnose fields they cannot support; point-cloud and tiles layers retain
the exact MapScene integration diagnostics. Use their dedicated renderers for
implemented standalone workflows. See [recipes](mapscene-diagnostics.md),
[styles and bundles](styles-bundles.md), and [point clouds](pointcloud-tiles.md).

## Animation, video and cartography

`CameraAnimation` retains target-aware keyframes. `TerrainOrbitRig`,
`TerrainRailRig` and `TerrainTargetFollowRig` bake clearance-aware paths.
`renderFrames` yields deterministic frames with microsecond timestamps;
`encodeVideo` uses WebCodecs and returns an MP4/WebM Blob or a typed unavailable
codec result. Streams and AbortSignals replace subprocess/ffmpeg control.

`MapPlate`, `Legend`, `ScaleBar`, `NorthArrow`, `exportSvg` and `exportPdf` replace
Pillow/Matplotlib composition with browser canvas and vector outputs. Pro
operations require an offline verified license; the gallery offers a license
input and does not embed an entitlement. See [cartography](cartography.md) and
[licensing](utilities.md).

## Regional example adaptations

The [gallery](../examples/migration/index.html) runs the Forge3D operations from
the native examples using small offline fixtures: terrain, overlays, vector
geometry, labels, scalar buildings, scatter, picking, cameras, snapshots, video,
CRS, datasets, style diagnostics, COG, LAZ and map furniture. Its per-example
catalog records every selected workflow and the immutable native source hash.
Regional HTTP downloads, GIS/transport/climate analysis and editorial video
production remain application inputs. The gallery does not claim visual
reproduction of those regional publications.

## Removed APIs and explicit diagnostics

Removed `render_raster`, `render_polygons` and `render_raytrace_mesh` helpers
migrate to the renderer, vector layer and path-tracer outcomes respectively.
CSM is a cascade setting, not a shadow-filter value. Normal/mask VT paging,
textured buildings, experimental label cases and underdeveloped MapScene paths
retain structured diagnostics. PLY, Draco and design-only TV11 shadow work do
not acquire an implementation claim from a documentation mapping. See the
[tombstone and support index](workflow-support.md).

## Verify the migration

From `crates/forge3d-web`, run `npm run test:w23` for coverage, asset integrity,
documentation links, fenced code and the source/dist gallery. Run
`npm run test:package-consumer:w23` from a clean committed checkout for the same
gallery using only the installed npm tarball under strict CSP. Fixture
provenance records distinguish historical illustrations, native-derived
controls and browser regression data. W24 owns physical browser qualification.
