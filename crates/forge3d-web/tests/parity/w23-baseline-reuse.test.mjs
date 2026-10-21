import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkflows } from '../../examples/migration/workflows.js';

function fixture({ suppressMaterials = false, afterRender } = {}) {
  const calls = [], frames = [], outputs = [];
  let disposed = 0;
  class Frame {
    constructor(width, height, data) { Object.assign(this, { width, height, data }); }
    async toPng() { return new Blob([this.data]); }
  }
  const pixels = value => Uint8Array.from({ length: 64 }, (_, i) => i % 4 === 3 ? 255 : value);
  class SceneRecipe {
    constructor(input) { this.key = JSON.stringify(input, (_, v) => ArrayBuffer.isView(v) ? [v.constructor.name, ...v] : v); }
    serialize() { return this.key; }
  }
  class MapScene {
    constructor(input) { this.input = input; }
    async render() {
      calls.push(this.input);
      const material = !suppressMaterials && this.input.terrain.source.data.material;
      const value = 20 + (material ? 40 : 0) + (this.input.shadows?.enabled ? 30 : 0) + (this.input.layers?.length ?? 0) * 10 + (this.input.environment?.water ? 80 : 0);
      const frame = new Frame(192, 128, pixels(value)); frames.push(frame);
      await afterRender?.(this.input, calls.length);
      return { frame, metrics: { coveragePixels: 501 }, executedLayerIds: (this.input.layers ?? []).map(l => l.layerId) };
    }
    dispose() { disposed++; }
    getMemoryReport() { return { cpuBytes: 0, gpuBytes: 0 }; }
  }
  const api = { Frame, SceneRecipe, MapScene, getTerrainMaterialDefaults: () => ({}), Forge3DEnvironment: class {
    constructor(input) { this.input = input; }
    snapshot() { return this.input; }
  }, Forge3DRuntime: { create: async () => {
    let value = 20;
    return { setTerrain() {}, setCamera() {}, render() {}, setIbl() { value += 50; }, readRgba: async () => pixels(value), dispose() {} };
  } }, ImageBasedLighting: { fromRGBE: async () => ({ prepare: async () => ({ snapshot: () => ({ intensity: 1 }), prepared: true }) }) } };
  const controller = new AbortController(), canvas = { getContext: () => ({ putImageData() {} }) };
  return { api, calls, frames, outputs, controller, disposed: () => disposed,
    workflows: createWorkflows(api, canvas, controller.signal, (blob, name) => outputs.push(name)) };
}

async function withFixture(work, options) {
  const original = globalThis.ImageData, document = globalThis.document;
  globalThis.ImageData = class {};
  globalThis.document = { createElement: () => ({ remove() {} }) };
  try { await work(fixture(options)); } finally { globalThis.ImageData = original; globalThis.document = document; }
}

test('the explicit render workflow always renders again even for an unchanged recipe', () => withFixture(async f => {
  await f.workflows.render(); await f.workflows.render();
  assert.equal(f.calls.length, 2); assert.equal(f.disposed(), 2); assert.equal(f.outputs.length, 2);
}));

test('material baseline reuses only the preceding real frame and preserves native changes, controls and PNG outputs', () => withFixture(async f => {
  await f.workflows.render(); const result = await f.workflows.materials();
  assert.equal(f.calls.length, 5); assert.equal(f.disposed(), 5);
  assert(result.changedPixels > 8); assert(result.shadowControlPixels > 8);
  assert.equal(f.calls.filter(x => x.shadows?.enabled).length, 2, 'Both real enabled-shadow renders still execute');
  assert.equal(f.outputs.filter(x => x === 'scene.png').length, 4, 'Before/after PNG publication remains unchanged');
}));

test('a material stage without an observed prior frame renders its own baseline', () => withFixture(async f => {
  await f.workflows.materials(); assert.equal(f.calls.length, 5); assert.equal(f.disposed(), 5);
  assert.equal(f.calls[0].terrain.source.data.material, undefined);
}));

test('mutating inline typed-array source pixels invalidates the serialized baseline recipe', () => withFixture(async f => {
  await f.workflows.raster();
  f.calls[0].layers[0].source.data.data[0] ^= 1;
  await f.workflows.materials();
  assert.equal(f.calls.length, 7); assert.equal(f.disposed(), 7);
}));

test('the baseline key describes inputs before rendering, even when sources change while awaiting a frame', () => withFixture(async f => {
  await f.workflows.raster(); await f.workflows.materials();
  assert.equal(f.calls.length, 7); assert.equal(f.disposed(), 7);
}, { afterRender: (input, call) => { if (call === 1) input.layers[0].source.data.data[0] ^= 1; } }));

test('mutating a previously returned frame invalidates its copied pixel evidence', () => withFixture(async f => {
  await f.workflows.render(); f.frames[0].data[0] ^= 1;
  await f.workflows.materials(); assert.equal(f.calls.length, 6); assert.equal(f.disposed(), 6);
}));

test('introducing an environment before water requires a fresh matching baseline', () => withFixture(async f => {
  await f.workflows.render(); await f.workflows.water();
  assert.equal(f.calls.length, 3); assert.equal(f.disposed(), 3);
  assert.equal(f.calls[0].environment, undefined); assert.deepEqual(f.calls[1].environment, {});
  assert.equal(f.calls[2].environment.water.length, 1);
}));

test('an intervening native-runtime frame cannot reuse a MapScene baseline', () => withFixture(async f => {
  // The second IBL snapshot has identical recipe bytes, but a different frame
  // owner. Identity must invalidate independently of serialized settings.
  await f.workflows.ibl(); await f.workflows.render(); await f.workflows.ibl(); await f.workflows.materials();
  assert.equal(f.calls.length, 6); assert.equal(f.disposed(), 6);
}));

test('a cached baseline observes cancellation before changing or publishing a frame', () => withFixture(async f => {
  await f.workflows.render(); f.controller.abort();
  await assert.rejects(f.workflows.materials(), { name: 'AbortError' });
  assert.equal(f.calls.length, 1); assert.equal(f.outputs.length, 1);
}));

test('baseline reuse still rejects a missing material contribution after a real render', () => withFixture(async f => {
  await f.workflows.render();
  await assert.rejects(f.workflows.materials(), /Materials/);
  assert.equal(f.calls.length, 2); assert.equal(f.disposed(), 2);
}, { suppressMaterials: true }));

test('independent scene/control draws run in pairs while every removal comparison still executes', async () => {
  const gate = Promise.withResolvers(); let active = 0, peak = 0;
  await withFixture(async f => {
    const pending = f.workflows.mapscene();
    try {
      await new Promise(setImmediate);
      assert.equal(f.calls.length, 2, 'A real control must start while the independent primary draw is pending');
      gate.resolve(); const result = await pending;
      assert.equal(peak, 2); assert.equal(f.calls.length, 3); assert.equal(f.disposed(), 3);
      assert(result.changedPixels.rivers > 8); assert(result.changedPixels.labels > 8);
    } finally { gate.resolve(); await pending.catch(() => {}); }
  }, { afterRender: async () => { peak = Math.max(peak, ++active); try { await gate.promise; } finally { active--; } } });
});

test('a failed paired draw waits for its in-flight peer and disposes both owners before rejecting', async () => {
  const gate = Promise.withResolvers(); let completed = false;
  await withFixture(async f => {
    const pending = f.workflows.raster().then(() => { completed = true; return null; }, error => { completed = true; return error; });
    try {
      await new Promise(setImmediate);
      assert.equal(f.calls.length, 2); assert.equal(completed, false, 'The rejected primary must not abandon its native control');
      gate.resolve(); const error = await pending;
      assert.equal(error.message, 'native draw failed'); assert.equal(f.disposed(), 2);
    } finally { gate.resolve(); await pending; }
  }, { afterRender: async (_, call) => { if (call === 1) throw Error('native draw failed'); await gate.promise; } });
});
