import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import * as api from '../../dist/index.js';

test('R12 public declarations and facade retain the reviewed API snapshot', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../api/public-api-snapshot.mjs', import.meta.url))], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr + result.stdout);
});
test('R12 browser classes and Scene instance methods are usable at their documented callsites', () => {
  for (const name of ['Forge3DRuntime', 'Forge3DScene', 'Forge3DSession', 'Frame', 'HdrFrame', 'AovFrame', 'MapScene', 'LabelLayer', 'PointBuffer']) assert.equal(typeof api[name], 'function', name);
  for (const method of ['setPostFx', 'setEnvironment', 'setShadows', 'setImageBasedLighting', 'snapshot', 'dispose']) {
    assert.equal(typeof api.Forge3DScene.prototype[method], 'function', method);
    assert.equal(api[method], undefined, method + ' must not become a free function');
  }
  const scene = new api.Forge3DScene();
  try {
    scene.setShadows({ enabled: true, filter: 'pcf' });
    assert.equal(scene.snapshot().shadows.config.enabled, true);
    scene.setShadows({ enabled: false });
    assert.equal(scene.snapshot().shadows.config.enabled, false);
    assert.throws(() => scene.setShadows({ filter: 'csm' }), e => e.code === 'INVALID_INPUT');
  } finally { scene.dispose(); }
  assert.equal(scene.disposed, true);
});
test('R12 removed Python delivery and rendering helpers are absent from browser ESM', () => {
  for (const name of ['render_raster', 'render_polygons', 'render_raytrace_mesh', 'vshade', 'dask', 'rasterio', '_native']) assert.equal(api[name], undefined, name);
  assert.equal(typeof api.renderOffline, 'function');
  assert.equal(typeof api.Forge3DOffscreenRenderer.create, 'function');
});

test('restored Mapbox Streets native fixture is parsed and its unsupported layers remain diagnosed', () => {
  const input=JSON.parse(readFileSync(new URL('../fixtures/w23/mapbox_streets_v8.json',import.meta.url),'utf8'));
  const style=api.parseStyle(input),result=style.toJSON();
  assert.equal(result.version,8);assert.equal(result.layers.length,11);
  assert.deepEqual(result.layers.map(l=>l.id),input.layers.map(l=>l.id));
  assert.deepEqual(result.sources,input.sources);
  const report=api.validateStyleSupport(result).toJSON();
  assert(report.diagnostics.some(d=>d.code==='unsupported_style_layer_type'&&d.layer_id==='background'));
  assert(report.diagnostics.some(d=>d.code==='experimental_feature'&&d.layer_id==='place-labels'));
});
