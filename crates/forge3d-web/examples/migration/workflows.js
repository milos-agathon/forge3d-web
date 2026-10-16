// A consolidated, offline browser equivalent of the final native example workflows.
// Each function performs work and checks its output before returning a review record.
/** @param {typeof import('../../types/index.js')} api
 * @param {HTMLCanvasElement} canvas
 * @param {AbortSignal} signal */
export function createWorkflows(api, canvas, signal) {
  const check = (ok, message) => { if (!ok) throw Error(message); };
  /** @type {import('../../types/index.js').CameraInput} */
  const camera = { position: [24, 32, 42], target: [0, 2, 0], up: [0, 1, 0], fovYDegrees: 42, near: .1, far: 500 };
  const heights = Float32Array.from({ length: 256 }, (_, i) => 5 * Math.exp(-((i % 16 - 7) ** 2 + (Math.floor(i / 16) - 7) ** 2) / 30));
  /** @returns {import('../../types/index.js').TerrainHeightmapInput} */
  const input = () => ({ width: 16, height: 16, heights: heights.slice(), spacing: [1.6, 1.6], bounds: [-12, -12, 12, 12], domain: [0, 5], crs: 'LOCAL' });
  const image = () => ({ width: 4, height: 4, data: Uint8Array.from({ length: 64 }, (_, i) => i % 4 === 3 ? 255 : i % 4 === 0 ? 210 : 90) });
  const transform = (x, y, z, s = 1) => new Float32Array([s, 0, 0, x, 0, s, 0, y, 0, 0, s, z, 0, 0, 0, 1]);
  /** @param {import('../../types/index.js').MapSceneLayerInput[]} [layers]
   * @returns {import('../../types/index.js').SceneRecipeInput} */
  const recipe = (layers = []) => ({ crs: 'LOCAL', terrain: { source: { id: 'dem', format: 'heightmap', crs: 'LOCAL', data: input() } }, camera,
    lighting: { name: 'daylight' }, output: { width: 192, height: 128 }, reproducibility: { seed: 23 }, runtimeOptions: { clearColor: [.02, .03, .05, 1] }, layers });
  /** @returns {import('../../types/index.js').VectorLayerInput} */
  const vectorData = () => ({ name: 'rivers', features: [{ id: 23, kind: 'line', positions: [[-9, 6, -2], [0, 6, 2], [9, 6, -2]], style: { lineWidth: 4, color: [.1, .4, 1, 1] } }] });
  /** @returns {import('../../types/index.js').VectorOverlayInput} */
  const vectorLayer = () => ({ kind: 'vector', layerId: 'rivers', source: { id: 'rivers', format: 'vector', crs: 'LOCAL', data: vectorData() } });
  /** @returns {import('../../types/index.js').MapSceneLabelLayerInput} */
  const labelLayer = () => ({ kind: 'labels', layerId: 'labels', source: { id: 'labels', format: 'labels', crs: 'LOCAL', data: [{ id: 'summit', text: 'Summit', geometry: { type: 'Point', coordinates: [32, 24, 0] } }] }, style: { fontSize: 14, color: [1, 1, 1, 1], haloWidth: 0 } });
  /** @param {import('../../types/index.js').MapSceneLayerInput[]} [layers] */
  async function render(layers = []) {
    const scene = new api.MapScene(recipe(layers));
    try {
      const result = await scene.render({ signal });
      check(result.metrics.coveragePixels > 500, 'Rendered frame has no covered surface');
      check(layers.every(l => result.executedLayerIds.includes(l.layerId)), 'A requested layer did not execute');
      canvas.width = result.frame.width; canvas.height = result.frame.height;
      canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(result.frame.data), result.frame.width, result.frame.height), 0, 0);
      return { frame: result.frame, coveragePixels: result.metrics.coveragePixels, layers: result.executedLayerIds };
    } finally { scene.dispose(); check(scene.getMemoryReport().cpuBytes === 0 && scene.getMemoryReport().gpuBytes === 0, 'MapScene disposal retained memory'); }
  }
  /** @template T @param {(runtime: import('../../types/index.js').Forge3DRuntime) => Promise<T>} work */
  async function withRuntime(work) {
    const element = document.createElement('canvas'); element.width = 192; element.height = 128;
    const runtime = await api.Forge3DRuntime.create(element, { width: 192, height: 128, devicePixelRatio: 1 });
    try { runtime.setTerrain(input()); runtime.setCamera(camera); return await work(runtime); }
    finally { runtime.dispose(); element.remove(); }
  }
  const animation = () => new api.CameraAnimation([
    { time: 0, phiDeg: 20, thetaDeg: 45, radius: 40, fovDeg: 42, target: [0, 2, 0] },
    { time: 1, phiDeg: 65, thetaDeg: 50, radius: 36, fovDeg: 42, target: [0, 2, 0] },
  ]);
  return {
    async esm() { check(typeof api.Forge3DRuntime.create === 'function', 'ESM export resolution failed'); return { exports: Object.keys(api).length }; },
    async terrain() {
      const dataset = api.TerrainDataset.fromArray(input());
      const statistics = dataset.statistics, slopes = dataset.slopeAspect();
      check(statistics.max > statistics.min && slopes.slopeRadians.length === 256, 'Terrain statistics/analysis failed');
      check(dataset.toTerrainInput().heights.length === heights.length, 'Terrain conversion lost samples');
      return { min: statistics.min, max: statistics.max, slopeCells: slopes.slopeRadians.length };
    },
    async png() {
      const source = image(), blob = await api.arrayToPng({ ...source, channels: 4 }), output = await api.pngToArray(blob);
      check(output.data.every((v, i) => v === source.data[i]), 'PNG round trip changed RGBA bytes');
      return { bytes: blob.size, exact: true };
    },
    async presets() {
      const names = api.rendererPresetNames();
      for (const name of names) api.RendererConfig.preset(name).copy().validate();
      return { names, convertedPresets: await (await fetch(new URL('./presets.json', import.meta.url), { signal })).json() };
    },
    async render() { const r = await render(); return { coveragePixels: r.coveragePixels }; },
    async raster() {
      const r = await render([{ kind: 'raster', layerId: 'landcover', source: { id: 'landcover', format: 'rgba', crs: 'LOCAL', data: image() }, options: { opacity: .6, blendMode: 'multiply' } }]);
      return { layers: r.layers, coveragePixels: r.coveragePixels };
    },
    async vectors() { const r = await render([vectorLayer()]); return { layers: r.layers, coveragePixels: r.coveragePixels }; },
    async labels() {
      const layer = await api.LabelLayer.create();
      try {
        const added = layer.addLabel('Summit', [32, 24, 0]);
        const line = layer.addLineLabel('ROAD', [[10, 80, 0], [160, 80, 0]]);
        const curved = layer.addCurvedLabel('Curved', [[0, 0, 0], [10, 10, 0], [20, 0, 0]]);
        const terrain = layer.addLineLabel('Terrain', [[0, 0, 0], [100, 0, 0]], {}, 'terrain');
        const callout = layer.addCallout('Peak', [80, 30, 0]);
        layer.setTypography({ tracking: .05, kerning: true, lineHeight: 1.2 });
        layer.setDeclutterAlgorithm('annealing', { seed: 123 });
        check(added.ok && line.ok && callout.ok && !curved.ok && curved.diagnostics.length > 0, 'Label API truth contract changed');
        layer.setLabelsEnabled(false); check(!layer.enabled, 'Label visibility change failed'); layer.setLabelsEnabled(true);
        const placement = layer.render({ viewport: { width: 192, height: 128 } });
        check(placement.glyphCount > 0, 'Labels emitted no glyph geometry');
        const r = await render([vectorLayer(), labelLayer()]);
        return { layers: r.layers, coveragePixels: r.coveragePixels, curved: curved.diagnostics.map(d => d.code), terrain: terrain.diagnostics.map(d => d.code), glyphs: placement.glyphCount };
      } finally { layer.dispose(); check(layer.memoryReport().cpuBytes === 0, 'Label disposal retained memory'); }
    },
    async mapscene() {
      const r = await render([vectorLayer(), labelLayer()]); return { layers: r.layers, coveragePixels: r.coveragePixels };
    },
    async buildings() {
      const mesh = api.generatePrimitive('box');
      const r = await render([{ kind: 'buildings', layerId: 'buildings', source: { id: 'buildings', format: 'buildings', crs: 'LOCAL', data: [{ id: 'warehouse', mesh }] }, transforms: transform(1, 6, 0, 3) }]);
      return { layers: r.layers, coveragePixels: r.coveragePixels };
    },
    async mesh() {
      const mesh = api.generatePrimitive('box'), encoded = await api.exportMesh(mesh, 'obj');
      check(encoded.size > 100 && api.meshBounds(mesh).max[0] > api.meshBounds(mesh).min[0], 'Mesh export failed');
      return { vertices: mesh.positions.length / 3, objBytes: encoded.size };
    },
    async scatter() {
      const mesh = api.generatePrimitive('box');
      const r = await render([{ kind: 'scatter', layerId: 'population', batches: [{ name: 'population', levels: [{ mesh }], transforms: new Float32Array([...transform(-4, 6, 0, 2), ...transform(4, 6, 0, 3)]), color: [.2, .8, .4, 1] }] }]);
      return { instances: 2, layers: r.layers };
    },
    async crs() {
      const crs = await api.CrsTransformer.create();
      try {
        const projected = await crs.transformCoords([[9, 40]], 'EPSG:4326', 'EPSG:32632');
        const back = await crs.transformCoords(new Float64Array(projected.flat()), 'EPSG:32632', 'EPSG:4326');
        check(Math.abs(projected[0][0] - 500000) < .01 && Math.abs(back[1] - 40) < 1e-7, 'CRS control failed');
        return { projected, roundTrip: back };
      } finally { crs.dispose(); }
    },
    async datasets() {
      const registry = new api.DatasetRegistry();
      try { const dem = await registry.miniDem({ signal }); const boundaries = await registry.sampleBoundaries({ signal });
        check(dem.data.length > 0 && boundaries.type === 'FeatureCollection', 'Bundled datasets failed');
        return { samples: dem.data.length, features: boundaries.features.length };
      } finally { registry.dispose(); }
    },
    async style() {
      const original = await (await fetch(new URL('./sample-style.json', import.meta.url), { signal })).json();
      const style = new api.StyleSpec(original), report = api.validateStyleSupport(style.toJSON());
      check(style.toJSON().layers.length > 0, 'Restored native style is empty');
      const runnable = api.parseStyle({ version: 8, sources: {}, layers: [{ id: 'river-style', type: 'line', source: 'rivers', paint: { 'line-color': '#2080ff', 'line-width': 4 } }] });
      const compiled = api.compileStyle(runnable, { rivers: vectorData().features }, { crs: 'LOCAL' });
      const rendered = await render(compiled.layers);
      return { layers: style.toJSON().layers.length, support: report.toJSON(), executedLayers: rendered.layers };
    },
    async diagnostics() {
      const entries = api.getMapSceneSupportMatrix();
      check(entries.length > 0, 'No support matrix');
      const scene = new api.MapScene(recipe([{ kind: 'point-cloud', layerId: 'unsupported-cloud', source: { id: 'cloud', format: 'pointcloud', crs: 'LOCAL', data: { positions: new Float32Array([0, 0, 0]) } } }]));
      try { const report = scene.validate(); check(report.toJSON().diagnostics.some(d => d.severity === 'error'), 'Unsupported MapScene point cloud reported success'); return { supportEntries: entries.length, report: report.toJSON() }; }
      finally { scene.dispose(); }
    },
    async bundle() {
      const scene = new api.MapScene(recipe([vectorLayer()])); let loaded;
      try { await scene.prepare({ signal }); const blob = await scene.saveBundle({ signal }); loaded = await api.MapScene.loadBundle(blob, { signal });
        const r = await loaded.render({ signal }); check(r.executedLayerIds.includes('rivers'), 'Bundle lost vector layer');
        return { bytes: blob.size, restoredLayers: r.executedLayerIds };
      } finally { loaded?.dispose(); scene.dispose(); }
    },
    async colormaps() {
      const cmap = api.colormaps.get('forge3d:viridis');
      const colors = [0, .5, 1].map(t => cmap.sample(t));
      check(JSON.stringify(colors[0]) !== JSON.stringify(colors[2]), 'Colormap collapsed');
      return { colors };
    },
    async furniture() {
      const r = await render(), plate = new api.MapPlate({ width: 320, height: 240, margin: [24, 64, 24, 16] }), vectors = new api.VectorScene();
      try {
        plate.setMapRegion(r.frame, new api.BBox(0, 0, 24000, 24000, 'LOCAL'));
        plate.addLegend(await new api.Legend(api.colormaps.get('forge3d:viridis'), [0, 5], { barHeight: 72, fontSize: 10 }).render());
        plate.addScaleBar(await new api.ScaleBar(125, { widthPx: 100, fontSize: 10 }).render());
        plate.addNorthArrow(await new api.NorthArrow({ size: 32 }).render());
        vectors.addPolygon([[0, 0], [100, 0], [100, 60], [0, 60]], { fillColor: [.2, .6, .4, 1] }).addLabel('Map', [50, 30], { fontSize: 12 });
        const options = { width: 200, height: 120, bounds: new api.Bounds(0, 0, 100, 60) };
        const png = await plate.exportPng(), svg = await api.exportSvg(vectors, options), pdf = await api.exportPdf(vectors, options);
        check(png.size > 100 && api.validateSvg(await svg.text()) && pdf.size > 100, 'Cartographic export empty or invalid'); return { pngBytes: png.size, svgBytes: svg.size, pdfBytes: pdf.size };
      } finally { plate.dispose(); vectors.dispose(); }
    },
    async animation() {
      return withRuntime(async runtime => {
        const timestamps = []; for await (const rendered of api.renderFrames(runtime, { animation: animation(), fps: 2, signal })) timestamps.push(rendered.timestampUs);
        check(JSON.stringify(timestamps) === '[0,500000,1000000]', 'Frame sequence is not deterministic'); return { timestamps };
      });
    },
    async video() {
      return withRuntime(async runtime => {
        try { const result = await api.encodeVideo(api.renderFrames(runtime, { animation: animation(), fps: 2, signal }), { fps: 2, container: 'mp4', signal });
          check(result.blob.size > 100, 'Video mux produced an empty file'); return { bytes: result.blob.size, mime: result.blob.type };
        } catch (error) { if (error.code !== 'UNSUPPORTED_FEATURE' || error.details?.reason !== 'codec-unavailable') throw error; return { unavailable: { code: error.code, reason: error.details.reason } }; }
      });
    },
    async rigs() {
      const source = new api.TerrainRigSource({ heights, width: 16, height: 16, terrainWidth: 24 });
      const rig = new api.TerrainOrbitRig({ targetXZ: [12, 12], radius: 8, duration: 1, phiStartDeg: 0, phiEndDeg: 90, thetaStartDeg: 45, clearance: { minimumHeight: 2 } });
      const path = rig.bake(source, { samplesPerSecond: 4 }); check(path.toJSON().keyframes.length > 1, 'Rig produced no path'); return { keyframes: path.toJSON().keyframes.length };
    },
    async materials() {
      return withRuntime(async runtime => { runtime.setTerrain({ ...input(), material: { ...api.getTerrainMaterialDefaults(), pom: { enabled: true }, layers: { snow: { enabled: true, altitudeMin: .7, altitudeBlend: .2 } } } }); const shadows = new api.Forge3DScene(); try { shadows.setShadows({ enabled: true, filter: 'pcf' }); runtime.setShadows(shadows.snapshot().shadows); } finally { shadows.dispose(); } runtime.render(); const data = await runtime.readRgba(); check(data.some(v => v !== 0), 'Material render empty'); return { bytes: data.length, shadowConfig: new api.ShadowConfig().snapshot() }; });
    },
    async environment() {
      const sun = api.sunPosition(52, 4, '2026-06-21T12:00:00Z');
      const haze = await api.generateDensityVolume({ preset: 'localized_haze', bounds: [-12, 0, -12, 12, 10, 12], dimensions: [8, 8, 8], densityScale: 2, seed: 23 });
      const environment = new api.Forge3DEnvironment({ sunClock: { latitude: 52, longitude: 4, unixSeconds: Date.parse('2026-06-21T12:00:00Z') / 1000, timeScale: 1 }, sky: { model: 'hosek-wilkie', turbidity: 2 }, fog: { mode: 'height', density: .01 }, clouds: { mode: 'hybrid', preset: 'gentle', height: 40, thickness: 20, seed: 23 }, volumes: [haze] });
      return withRuntime(async runtime => { runtime.setEnvironment(environment); runtime.render(); const bytes = await runtime.readRgba(); check(bytes.length === 192 * 128 * 4, 'Environment readback failed'); return { sun, bytes: bytes.length }; });
    },
    async water() {
      return withRuntime(async runtime => { runtime.setEnvironment(new api.Forge3DEnvironment({ water: [{ bounds: [-12, -12, 12, 12], height: 2, mode: 'animated' }] })); runtime.render(); const bytes = await runtime.readRgba(); return { bytes: bytes.length }; });
    },
    async viewer() {
      const element = document.createElement('canvas'); element.width = 192; element.height = 128; element.setAttribute('aria-label', 'Migrated interactive viewer'); document.body.append(element);
      let viewer;
      try { viewer = await api.Forge3DViewer.create(element, { runtime: { width: 192, height: 128, devicePixelRatio: 1 } }); await viewer.setTerrain(input()); const png = await viewer.screenshot(); check(png.size > 100, 'Viewer snapshot empty'); return { pngBytes: png.size }; }
      finally { viewer?.dispose(); element.remove(); }
    },
    async picking() {
      return withRuntime(async runtime => {
        const layers = new api.VectorLayers(); let picker;
        try { layers.add(vectorData()); runtime.setVectorLayers(layers); runtime.render(); picker = new api.VectorPicker(runtime, layers);
          const hits = await picker.lasso([[0, 0], [192, 0], [192, 128], [0, 128]]); check(hits.some(h => h.id === 23), 'Rich picking did not find rendered river');
          layers.setSelection('selected', hits.map(h => h.id), { outline: true }); runtime.setVectorLayers(layers); runtime.render(); return { selected: hits.map(h => h.id) };
        } finally { picker?.dispose(); layers.dispose(); }
      });
    },
    async pointcloud() {
      const dataset = await api.openLaz(new URL('./autzen.laz', import.meta.url), { signal });
      let renderer, layer;
      try { const root = dataset.rootNode(), points = await dataset.readPoints(root.key, signal), buffer = new api.PointBuffer(points);
        try {
          check(buffer.pointCount > 0 && buffer.createGpuBuffer().length === buffer.pointCount * 6, 'LAZ decode/point-buffer upload failed');
          const bounds = dataset.bounds, center = bounds.min.map((v, i) => (v + bounds.max[i]) / 2), extent = Math.max(...bounds.min.map((v, i) => bounds.max[i] - v), 1), scale = 1.8 / extent;
          /** @type {import('../../types/index.js').PointView} */
          const view = { position: [center[0], center[1], center[2] + extent], viewportHeight: 128, fovY: Math.PI / 4,
            viewProjection: [scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, -.5 / extent, 0, -center[0] * scale, -center[1] * scale, .5 + center[2] * .5 / extent, 1] };
          layer = new api.PointCloudLayer(dataset, { pointBudget: 120000, style: { pointSize: 2, colorMode: 'elevation' } });
          await layer.update(view, signal); renderer = await api.PointCloudRenderer.create(new OffscreenCanvas(192, 128)); renderer.setLayers([layer]); await renderer.render(view, signal);
          const pixels = await renderer.readRgba(signal); let covered = 0;
          for (let i = 0; i < pixels.length; i += 4) if (Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) > 20) covered++;
          check(covered > 100, 'Point cloud GPU draw has no coverage');
          return { points: buffer.pointCount, bytes: buffer.gpuBytes, coveredPixels: covered };
        }
        finally { buffer.dispose(); }
      } finally { renderer?.dispose(); layer?.dispose(); dataset.dispose(); if (renderer) check(renderer.getStats(false).gpuBytes === 0, 'Point renderer disposal retained memory'); }
    },
    async cog() {
      const scheduler = new api.RangeScheduler(), cog = await api.CogDataset.open(new URL('./predictor.tif', import.meta.url), { scheduler });
      try { const tile = await cog.readTile(0, 0, 0, { signal }); check(tile.length > 0, 'COG tile decode empty'); return { values: tile.length, stats: scheduler.stats() }; }
      finally { cog.dispose(); scheduler.dispose(); }
    },
  };
}
