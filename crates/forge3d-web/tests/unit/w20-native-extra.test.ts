import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Bounds, VectorScene, project2dToScreen, project3dTo2d } from '../../src-ts/vector-export-scene.js';
import { generateSvg, validateSvg } from '../../src-ts/vector-export.js';
import { colormaps } from '../../src-ts/colormaps.js';
const native = (source: string, name: string, run: () => unknown) => it(`${source}::tests::${name}`, run);
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const label = (text = 'Test', screenPosition: [number, number] | null = [100, 200], visible = true) => new VectorScene().addScreenLabels([{ text, screenPosition, visible }], 600);
const svg = (scene: VectorScene) => generateSvg(scene, { width: 800, height: 600, bounds: new Bounds(0, 0, 800, 600) });
const triangle: [number, number][] = [[10, 10], [90, 10], [50, 90]];
native('src/export/mod.rs', 'test_project_3d_to_2d_center', () => expect(project3dTo2d([0, 0, 0], identity, [800, 600])).toEqual([400, 300]));
native('src/export/mod.rs', 'test_project_3d_behind_camera', () => { const f = 1 / Math.tan(Math.PI / 8), m = [f, 0, 0, 0, 0, f, 0, 0, 0, 0, -100 / 99.9, -1, 0, 0, -10 / 99.9, 0]; expect(project3dTo2d([0, 0, 10], m, [800, 600])).toBeNull(); expect(project3dTo2d([0, 0, -10], m, [800, 600])).toEqual([400, 300]); });
native('src/export/mod.rs', 'test_project_2d_to_screen', () => { const b = new Bounds(); expect([[0, 0], [100, 100], [50, 50]].map(p => project2dToScreen(p as [number, number], b, [800, 600]))).toEqual([[0, 600], [800, 0], [400, 300]]); });
native('src/export/mod.rs', 'test_svg_generation', () => { const out = generateSvg(new VectorScene().addPolygon(triangle, { fillColor: [1, 0, 0, 1], strokeWidth: 2 }).addPolyline([[0, 50], [100, 50]], { strokeColor: [0, 0, 1, 1], strokeWidth: 1.5 }), { bounds: new Bounds() }); expect(validateSvg(out)).toBe(true); expect(out).toContain('viewBox="0 0 800 600"'); expect(out).toContain('<polygon'); expect(out).toContain('<polyline'); });
native('src/export/mod.rs', 'test_labels_to_svg', () => { const out = svg(label('Test Label', [400, 300])); expect(out).toContain('Test Label'); expect(out).toContain('font-size="14.00"'); });
native('src/export/projection.rs', 'test_bounds_from_extents', () => { const b = new Bounds(10, 20, 110, 120); expect([b.width, b.height, b.center]).toEqual([100, 100, [60, 70]]); });
native('src/export/projection.rs', 'test_bounds_expand', () => { const b = new Bounds(0, 0, 1, 1); b.expandToInclude([2, -1]); expect(b).toEqual(new Bounds(0, -1, 2, 1)); });
native('src/export/projection.rs', 'test_bounds_from_points', () => expect(Bounds.fromPoints([[10, 20], [30, 40], [5, 35]])).toEqual(new Bounds(5, 20, 30, 40)));
native('src/export/projection.rs', 'test_bounds_padding', () => expect(new Bounds(10, 10, 90, 90).withPadding(5)).toEqual(new Bounds(5, 5, 95, 95)));
native('src/export/svg.rs', 'test_color_to_hex', () => { for (const [color, expected] of [[[1, 0, 0, 1], '#ff0000'], [[0, 1, 0, 1], '#00ff00'], [[0, 0, 1, 1], '#0000ff'], [[.5, .5, .5, 1], '#7f7f7f']] as const) expect(generateSvg(new VectorScene().addPolygon(triangle, { fillColor: color }))).toContain(`fill="${expected}"`); });
native('src/export/svg.rs', 'test_color_to_rgba', () => { expect(generateSvg(new VectorScene().addPolygon(triangle, { fillColor: [1, 0, 0, 1] }))).toContain('fill="#ff0000"'); expect(generateSvg(new VectorScene().addPolygon(triangle, { fillColor: [1, 0, 0, .5] }))).toContain('fill="rgba(255,0,0,0.50)"'); });
native('src/export/svg.rs', 'test_empty_svg', () => { const out = generateSvg(new VectorScene()); expect(out).toContain('<?xml version'); expect(validateSvg(out)).toBe(true); expect(out).toContain('</svg>'); });
native('src/export/svg.rs', 'test_polygon_with_holes', () => { const out = generateSvg(new VectorScene().addPolygon([[0, 0], [100, 0], [100, 100], [0, 100]], { holes: [[[25, 25], [75, 25], [75, 75], [25, 75]]] }), { bounds: new Bounds(), width: 100, height: 100 }); expect(out).toContain('fill-rule="evenodd"'); expect(out).toContain(' M 25.00,75.00'); expect(validateSvg(out)).toBe(true); });
native('src/export/svg_labels.rs', 'test_escape_xml', () => { const out = svg(label('Hello & World <test> "quoted"')); expect(out).toContain('Hello &amp; World &lt;test&gt; &quot;quoted&quot;'); expect(validateSvg(out)).toBe(true); });
native('src/export/svg_labels.rs', 'test_single_label', () => { const out = svg(label()); expect(out).toContain('x="100.00" y="200.00"'); expect(out).toContain('font-family="sans-serif"'); });
native('src/export/svg_labels.rs', 'test_label_with_halo', () => { const out = svg(new VectorScene().addScreenLabels([{ text: 'Halo Test', screenPosition: [50, 50], style: { haloWidth: 2, haloColor: [1, 1, 1, .8] } }], 600)); expect(out.match(/<text /g)).toHaveLength(2); expect(out).toContain('stroke-width="4.00"'); });
native('src/export/svg_labels.rs', 'test_invisible_label', () => { const s = label('Hidden', [100, 100], false); expect(s.labels).toEqual([]); expect(svg(s)).not.toContain('Hidden'); });
native('src/export/svg_labels.rs', 'test_label_without_screen_pos', () => { const s = label('No Position', null); expect(s.labels).toEqual([]); expect(svg(s)).not.toContain('No Position'); });
native('src/export/svg_labels.rs', 'test_complete_document', () => { const out = svg(label('Document Test', [400, 300])); expect(out).toContain('<?xml version'); expect(out).toContain('viewBox="0 0 800 600"'); expect(out).toContain('Document Test'); expect(out).toContain('</svg>'); expect(validateSvg(out)).toBe(true); });
native('tests/test_colormaps_core.py', 'test_core_available_min', () => expect(colormaps.available()).toContain('forge3d:viridis'));
native('tests/test_colormaps_core.py', 'test_monotonic_lightness', () => {
  const rgba = colormaps.get('forge3d:viridis').rgba, lightness = [];
  // CIE Lab D65 L*: input is already linear sRGB, Y_n=1.
  for (let i = 0; i < rgba.length; i += 4) { const y = .2126 * rgba[i]! + .7152 * rgba[i + 1]! + .0722 * rgba[i + 2]!; lightness.push(y > (6 / 29) ** 3 ? 116 * Math.cbrt(y) - 16 : (29 / 3) ** 3 * y); }
  expect(Math.min(...lightness.slice(1).map((l, i) => l - lightness[i]!))).toBeGreaterThanOrEqual(-.01);
});
native('tests/test_colormaps_core.py', 'test_hash_determinism', () => expect(colormaps.get('forge3d:viridis').rgba).toEqual(colormaps.get('forge3d:viridis').rgba));
native('tests/test_colormaps_cvd.py', 'test_vik_diverging_zero_contrast', () => {
  const rgba = colormaps.get('forge3d:vik').rgba;
  // Machado et al. 2009, severity 100 deuteranomaly, linear sRGB forward simulation.
  // The historical colorspacious tuple API is invalid in 1.1.2; preserve its endpoint-distinction assertion using the published matrix.
  const matrix = [[.367322, .860646, -.227968], [.280085, .672501, .047413], [-.01182, .04294, .968881]];
  const display = (v: number) => v <= .0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - .055;
  const simulate = (i: number) => matrix.map(row => display(row.reduce((n, v, k) => n + v * rgba[i + k]!, 0)));
  const low = simulate(0), high = simulate(rgba.length - 4);
  expect(Math.hypot(...low.map((v, i) => v - high[i]!))).toBeGreaterThan(.2);
});
it('W20 compares every coordinate, hole, label and style against the recorded native SVG', () => {
  const oracle = JSON.parse(readFileSync(new URL('../fixtures/w20/native-oracle.json', import.meta.url), 'utf8'));
  const s = new VectorScene().addPolygon([[0, 0], [100, 0], [100, 100], [0, 100]], { holes: [[[25, 25], [75, 25], [75, 75], [25, 75]]], fillColor: [1, 0, 0, 1], strokeWidth: 0 }).addPolyline([[0, 50], [100, 50]], { strokeColor: [0, 0, 1, 1], strokeWidth: 2 }).addLabel('Montaña & <Peak>', [50, 80]);
  const actual = generateSvg(s, { width: 200, height: 100, bounds: new Bounds() });
  const elements = (markup: string) => [...markup.matchAll(/<(path|polyline|text)\s([^>]+)>([^<]*)<\/text>|<(path|polyline)\s([^>]+)\/>/g)].map(m => ({ tag: m[1] ?? m[4], text: m[3] ?? '', attributes: Object.fromEntries([...((m[2] ?? m[5])!).matchAll(/([\w-]+)="([^"]*)"/g)].map(a => [a[1], a[2]!.replace(/([ML])\s+/g, '$1').replace(/,\s+/g, ',').replace(/\s+/g, ' ').trim()])) }));
  expect(validateSvg(actual)).toBe(true); expect(elements(actual)).toHaveLength(4); expect(elements(actual)).toEqual(elements(oracle.svg));
});
