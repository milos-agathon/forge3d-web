# Cartographic output and colormaps (W20)

`MapPlate`, `Legend`, `ScaleBar`, `NorthArrow`, `VectorScene` and `ColormapRegistry`
implement M05–M07. All file exports return `Promise<Blob>`; `generateSvg` returns
markup for embedding. The [example](../examples/cartography.html) renders a W18
`MapScene` terrain frame and offers PNG, JPEG, SVG and PDF downloads. Its worker
example executes the same composition API on `OffscreenCanvas`.

## Compose a plate

```ts
import { MapPlate, BBox, Legend, ScaleBar, NorthArrow, colormaps } from '@forge3d/web';

// result.frame is the Frame returned by MapScene.render().
const plate = new MapPlate({ width: 1600, height: 1000 });
const bbox = new BBox(-122, 46, -121, 47);
plate.setMapRegion(result.frame, bbox);
plate.addTitle('Mountain atlas');
plate.addLegend(await new Legend(colormaps.get('forge3d:viridis'), [0, 3000]).render());
// Use the displayed map width after aspect-preserving fitting.
const width = (await plate.layout()).mapImage!.width;
plate.addScaleBar(await new ScaleBar(ScaleBar.computeMetersPerPixel(bbox, width)).render());
plate.addNorthArrow(await new NorthArrow({ rotationDeg: 15 }).render());
plate.addInset(insetFrame, { size: [180, 120], position: 'bottom-right', borderWidth: 2 });
const png = await plate.exportPng({ signal });
const jpeg = await plate.exportJpeg({ quality: 0.9, signal });
plate.dispose();
```

Plate dimensions, margins, furniture and positions use logical output pixels;
DPR/browser zoom do not alter the export. Default dimensions are 1600×1000,
margins `[top,right,bottom,left]` are `[60,200,80,40]`, background is opaque white,
and `dpi` metadata defaults to 150. Pixel dimensions determine PNG/JPEG output;
Canvas encoders use their browser's resolution metadata. Main maps fit and center
with native integer rounding. `layout()` returns the actual letterboxed map
rectangle and each furniture rectangle. Anchors include all four corners, the
four edges and center. Insets draw their border outside the image and clip at
the plate boundary. `addLegend` defaults to the reserved right margin.
Title boxes use measured ink height. Latin text uses the frozen native Pillow
BASIC integer advances and ascender anchor; complex scripts retain browser shaping.
The native comparison fixes the font bytes and BASIC engine rather than depending
on system fallback fonts or optional RAQM. Furniture draws in native order:
legend, scale bar, north arrow, then insets, regardless of insertion order.
Scale bars begin at their left padding even when the label is wider. The N is bold.

Inputs are `Frame` or `{width,height,data,channels?:1|3|4}` (gray/RGB/RGBA8).
Inputs are copied. Alpha uses straight source-over Canvas composition. Colors
in configuration are normalized sRGB RGBA, including alpha in `[0,1]`.
`compose()` returns an RGBA8 `Frame`. Furniture `render({signal,maxBytes})` methods return frames and admit allocations
before rendering. Pre-aborted requests fail before font loading.
Verified DejaVu Sans 2.37 regular/bold and Noto Arabic/Devanagari fonts load from the package through
`Document.fonts` or `WorkerGlobalScope.fonts`, with no external font service.

Legends support both orientations, title, tick count/length, suffix, font sizes,
colors and fixed formats such as `'{:.0f}'` and `'{:.1f}'`. Gradients use native
nearest sample indices and convert linear RGB to display sRGB. A linear value
of 0.25 becomes byte 137. Horizontal ticks follow the bar's long axis; image
dimensions match the native layout. Unlike native's transposed horizontal tick
coordinates, horizontal ticks remain attached to the visible bar. Degenerate domains are allowed.

Scale bars support metres/kilometres/miles/feet and simple/alternating styles.
`metrics()` exposes the chosen distance and drawn pixel length. Geographic
distance uses the native `111320*cos(centerLatitude)` longitude approximation.
For projected/local bounds supply `metersPerUnit` to `computeMetersPerPixel`,
or supply measured `metersPerPixel` directly. Perspective terrain needs a local
ground scale at the feature of interest; a bounding-box width alone does not
measure perspective foreshortening. North arrows support `arrow`, `compass` and
`simple`, clockwise rotation, N label, foreground/background and border.

## Vector output

```ts
import { VectorScene, Bounds, exportSvg, exportPdf } from '@forge3d/web';
const vectors = new VectorScene();
vectors.addPolygon([[0,0],[100,0],[100,100],[0,100]], {
  holes: [[[25,25],[75,25],[75,75],[25,75]]], fillColor: [0.2,0.4,0.8,1]
});
vectors.addPolyline([[0,50],[100,50]], { strokeColor: [0,0,0,1], strokeWidth: 2 });
vectors.addLabel('Montaña', [50,80], { fontSize: 14, haloWidth: 1.5 });
const options = { width: 800, height: 600, bounds: new Bounds(0,0,100,100) };
const svg = await exportSvg(vectors, { ...options, signal });
const pdf = await exportPdf(vectors, { ...options, dpi: 300, signal });
vectors.dispose();
```

Bounds include polygons, holes, lines and label positions. Automatic bounds add
10 units of padding. Geometry maps to the complete viewport with Y flipped;
degenerate ranges use the native fallback of one unit. `project2dToScreen` and
`project3dTo2d` expose the same conventions. 3D matrices are column-major; points
with clip W≤0 return null and offscreen points extrapolate. SVG coordinates use
configurable decimal precision (default two), even-odd holes, round line joins
and caps, escaped XML text/attributes and text halos. `validateSvg` checks XML
structure and root dimensions/viewBox in both main and worker contexts.

PDFs contain vector path operators, even-odd fills, opacity graphics states,
embedded subset fonts, searchable Unicode text and stroked halos. Page points
are `pixels*72/dpi`; default DPI is 300, matching the native export wrapper.
DejaVu and Noto fonts cover the bundled Latin/Arabic/Devanagari workflows. Both Blob exporters
accept `fonts: [{family,source}]` for custom sfnt/OTF fonts from browser byte
sources. Missing font families, corrupt fonts and PDF glyph coverage failures
raise structured input errors. Bold PDF weights use an additional glyph stroke.
PDF and SVG output bytes are deterministic for identical inputs and fonts.
SVG Blobs embed fonts under explicit private family names, including fallback
families. `generateSvg` uses native `sans-serif` by default and leaves font
resolution to its host.

`vectorSceneFromLayers` adapts visible W12 X/Z map geometry; this is a plan-view
coordinate adapter. `addLabelPlan(plan, viewportHeight)` exports W13 accepted
screen-space label centers into a scene whose bounds match that viewport.
`addScreenLabels(labels, viewportHeight)` accepts projected screen positions,
omits invisible labels and null/absent positions (including points behind the
camera), and reverses screen Y once before export.
File paths become browser byte sources and Blob output. Blobs can be downloaded,
written to a `WritableStream` or saved through File System Access/OPFS handles.

## Colormap ecosystem

`colormaps` is the default case-insensitive `ColormapRegistry`. The exact native
core stop tables provide `forge3d:viridis`, `forge3d:magma` and `forge3d:vik`.
`OKABE_ITO` provides the native categorical seed colors. Registry duplicates and
unknown palettes/providers fail explicitly. `registerProvider(name, callback)`
adapts application-owned cmcrameri/cmocean/colorcet/palettable or other palettes
without importing Python or fetching a CDN.

`colormapFromStops(name, stops, size=256)` accepts finite nondecreasing positions
and hex or normalized sRGB RGB(A) colors, converts to linear sRGB and interpolates
there. Positions may extend outside [0,1]; equal positions produce a right-continuous
hard edge, matching native `np.interp`, including float32 sample positions. A single
stop makes a constant table. Hex stop alpha is ignored, matching native
`from_stops`; numeric RGBA stop alpha is preserved. The separate `hexToRgba`
utility does honor an eight-digit hex alpha byte.
`Colormap.rgba` returns a copy of the Float32 linear table. `sample`, `reversed`,
`withEndcaps`, `toLinearRgba8`, `toDisplayRgba8` and `toTexture` preserve explicit
under/over/bad colors and straight alpha. `toTexture` returns an `rgba8unorm`
linear table for GPU upload; display bytes are intended for Canvas/UI.

`parseColormapJson` imports `{name?,stops:[[position,color],...]}`. CPT imports
support contiguous RGB/HSV/CMYK segments, slash/hex/grayscale RGB colors,
discontinuous boundaries, annotations and B/F/N endcaps. Interpolation occurs
in the declared CPT color model before conversion to linear RGB. Unsupported
models, malformed segments and invalid/nonfinite colors fail structurally.
`loadColormap(source,'json'|'cpt',{signal,maxBytes,size,name})` accepts URL,
File/Blob, ArrayBuffer, streams and the other browser byte sources.
`hexToRgb`, `hexToRgba`, `rgbToNormalized`, `interpolateHexColors` and
`elevationStopsFromHexColors` preserve the native color and DEM quantile helpers.

## Ownership and limits

These APIs own CPU data and Canvas objects, with no WebGPU device or renderer
ownership. Device loss cannot invalidate a saved frame. Canvas and FontFace
absence report `UNSUPPORTED_FEATURE`; disposal reports `RUNTIME_DISPOSED`.
`MapPlate` and `VectorScene` support idempotent `dispose`, `clear` and memory
reports. Plate mutations during composition are rejected. A shared font set is
retained per realm; per-operation canvases are released after exports.
The default conservative CPU budget is 128 MiB, with admission before canvas or
input-copy allocation. Images/plate dimensions are bounded at 16384 pixels per
axis; font files at 16 MiB; colormap source loads at 4 MiB by default. AbortSignal
rejects output, including while waiting for the shared font set. The shared load
continues for other callers. Font load failures use `IO_ERROR` with reason
`font-load-failed`; subsequent calls retry. JPEG drops transparency to black,
following the Canvas JPEG encoder; choose an opaque plate background when needed.

Run `npm run test:w20` for the native semantic ports and source/dist browser
suite. `npm run test:package-consumer:w20` rebuilds WASM, installs a clean npm
tarball under self-only CSP, checks declarations, repeats dist cases and renders
the PDFs with the separately pinned MuPDF test tool. It also production-builds
a Vite consumer at root and `/atlas/`, and tests an unbundled CDN-style versioned
subpath. Each mode renders fonts, titles, labelled SVG and PDF on both main and
worker threads. Literal asset URLs let bundlers emit fonts; PDF fontkit is a real
ESM bundle with its locked pako dependency. Module-worker consumers in Vite use
`worker: {format: 'es'}` (the facade includes W13's ESM shaping module).
