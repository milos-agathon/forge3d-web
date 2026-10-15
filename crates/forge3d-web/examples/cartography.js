import { makeCartographyChecks } from './cartography-checks.js';
const api = await (new URLSearchParams(location.search).has('source') ? import('../src-ts/index.ts') : import('../dist/index.js'));
const checks = makeCartographyChecks(api), urls = [];
window.__w20 = { api, ...checks, ready: true };
const status = document.querySelector('#status'); status.textContent = 'Ready to compose.';
async function compose() {
  const p = await checks.makePlate();
  let map;
  try {
    const size = 24, heights = Float32Array.from({ length: size * size }, (_, i) => 5 * Math.exp(-((i % size - 11) ** 2 + (Math.floor(i / size) - 11) ** 2) / 60));
    map = new api.MapScene({ crs: 'LOCAL', terrain: { source: { id: 'dem', format: 'heightmap', crs: 'LOCAL', data: { width: size, height: size, heights, spacing: [24 / (size - 1), 24 / (size - 1)], bounds: [-12, -12, 12, 12], domain: [0, 5], crs: 'LOCAL' } } }, camera: { position: [24, 32, 42], target: [0, 2, 0], up: [0, 1, 0], fovYDegrees: 42, near: .1, far: 500 }, lighting: { name: 'daylight' }, output: { width: 340, height: 226 }, layers: [] });
    const rendered = await map.render();
    if (rendered.metrics.coveragePixels < 1000) throw Error('Terrain frame has no covered surface');
    p.setMapRegion(rendered.frame, new api.BBox(0, 0, 24000, 24000, 'LOCAL'));
    p.addLegend(await new api.Legend(api.colormaps.get('forge3d:viridis'), [0, 5], { barHeight: 140, fontSize: 10, labelSuffix: ' m' }).render());
    p.addScaleBar(await new api.ScaleBar(24000 / 340, { widthPx: 140, fontSize: 10 }).render());
    const frame = await p.compose(), canvas = document.querySelector('canvas'); canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height), 0, 0);
    const vectors = await checks.vectorExports(), blobs = { png: await p.exportPng(), jpeg: await p.exportJpeg(), ...vectors };
    urls.splice(0).forEach(url => URL.revokeObjectURL(url));
    for (const [type, blob] of Object.entries(blobs)) { const a = document.getElementById(type), url = URL.createObjectURL(blob); urls.push(url); a.href = url; a.download = `forge3d-map.${type === 'jpeg' ? 'jpg' : type}`; a.hidden = false; }
    status.textContent = 'Plate composed. Four downloads are ready.';
  } finally { map?.dispose(); p.dispose(); }
}
document.querySelector('#compose').onclick = () => { status.textContent = 'Composing…'; compose().catch(e => { status.textContent = e.message; }); };
addEventListener('pagehide', () => urls.splice(0).forEach(url => URL.revokeObjectURL(url)));
