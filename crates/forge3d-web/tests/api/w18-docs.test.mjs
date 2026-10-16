import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
const read = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
const doc = read('docs/mapscene-diagnostics.md');
test('documents the public MapScene API with truthful browser support levels', () => {
  for (const text of ['MapScene.render', 'MapScene.save_bundle', 'source-derived', 'WebGPU/WASM', 'last_render.backend', '`supported`', '`unsupported`', '`Pro-gated`', '`placeholder/fallback`']) assert.ok(doc.includes(text), text);
  assert.match(doc, /MapScene.render PNG path \| `supported`/);
  assert.match(doc, /Point-cloud MapScene path \| `placeholder\/fallback`/);
  assert.match(doc, /Tiles3D MapScene path \| `underdeveloped`/);
  assert.match(doc, /MapScene integration of G02-G04 is not yet implemented and tested/);
});
test('removes stale completion and feature ownership wording from the MapScene guide', () => {
  for (const text of ['TBD', 'later-owned', 'Owned by feature `004`', 'Owned by feature `003`', 'points/tiles are promoted']) assert.ok(!doc.includes(text), text);
});
test('documents every emitted MapScene validation code and the native required codes', () => {
  const sources = ['src-ts/map-validation.ts', 'src-ts/map-settings.ts', 'src-ts/map-resource-loader.ts', 'src-ts/map-layer-adapters.ts', 'src-ts/map-scene.ts'].map(read).join('\n');
  const codes = new Set([...sources.matchAll(/(?:mapProblem|settingProblem)\('([^']+)'/g)].map(m => m[1]));
  for (const code of ['missing_crs', 'missing_source_identity', 'missing_renderable_data', 'missing_external_asset', 'unsupported_asset_format', 'unsupported_output_format', 'unsupported_layer_type', 'unsupported_feature']) codes.add(code);
  assert.ok(codes.size >= 24);
  for (const code of codes) assert.ok(doc.includes('`' + code + '`'), code);
});
test('links canonical browser examples and the actual layer support guides', () => {
  for (const text of ['../examples/migration/index.html?example=mapscene_vector_labels.py', 'https://github.com/milos-agathon/forge3d/blob/d5cf3b578d7a946e2ca4008c42537380889537b3/crates/forge3d-web/examples/w18-mapscene.js', '(labels.md)', '(vector-layers.md)', '(geometry-mesh-io.md)', '(pointcloud-tiles.md)', '(support-matrix.md)', 'npm run test:w18']) assert.ok(doc.includes(text), text);
  const example = read('examples/w18-mapscene.js');
  for (const kind of ['raster', 'vector', 'labels', 'buildings']) assert.ok(example.includes("kind: '" + kind + "'"), kind);
  assert.ok(!/raw.?ipc/i.test(example));
});
test('records current MapScene diagnostics and explicit support ownership', () => {
  for (const text of ['LabelPlan', 'MapScene.validate', 'MapSceneBuildingLayer', 'missing_external_asset', 'unsupported_asset_format', 'python_public_3dtiles_incomplete', 'albedo-only', 'vt_unsupported_family', 'M03/W19', 'M04/W19', 'M02b', 'W20', 'W23']) assert.ok(doc.includes(text), text);
  assert.ok(!doc.includes('Owned by later MapScene'));
});
test('uses only the PRD taxonomy in the MapScene support table', () => {
  const table = doc.split('## Support and ownership')[1].split('Canonical examples')[0];
  const allowed = ['supported', 'underdeveloped', 'missing', 'Pro-gated', 'placeholder/fallback', 'experimental', 'unsupported', 'non-goal'];
  const rows = table.split('\n').filter(l => /^\| .*\| `/.test(l));
  assert.ok(rows.length >= 8);
  for (const row of rows) assert.ok(allowed.includes(row.split('|')[2].trim().replaceAll('`', '')), row);
});
test('states the native product boundaries and incomplete Cesium workflow', () => {
  for (const text of ['Streamed browser map delivery', 'Complete Mapbox style parity', 'Cesium-grade global runtime parity', 'General DCC', 'game-editor workflows', 'Textured PBR buildings', 'VT normal/mask runtime', 'not full Cesium runtime parity']) assert.ok(doc.includes(text), text);
  assert.ok(!doc.includes('production-ready 3D Tiles'));
});
