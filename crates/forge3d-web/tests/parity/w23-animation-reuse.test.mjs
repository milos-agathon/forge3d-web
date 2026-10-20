import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkflows } from '../../examples/migration/workflows.js';

function fixture() {
  let renders = 0;
  const encoded = [], outputs = [];
  class MapScene {
    async render() {
      const id = ++renders;
      return { frame: { width: 192, height: 128, data: new Uint8Array([id, 0, 0, 255]), toPng: async () => new Blob([String(id)]) }, metrics: { coveragePixels: 501 }, executedLayerIds: [] };
    }
    dispose() {}
    getMemoryReport() { return { cpuBytes: 0, gpuBytes: 0 }; }
  }
  const api = { MapScene, Forge3DRuntime: { create() {} }, CameraAnimation: class {
    constructor(keys) { this.keys = keys; }
    getKeyframes() { return this.keys; }
    evaluate() { return this.keys[0]; }
  }, cameraStateEye: () => [24, 32, 42], frameTimestampUs: i => i * 500000,
    encodeVideo: async source => {
      const ids = [], timestampsUs = [];
      for await (const item of source) { ids.push(item.frame.data[0]); timestampsUs.push(item.timestampUs); }
      encoded.push(ids);
      return { blob: new Blob([new Uint8Array(200)], { type: 'video/mp4' }), frameCount: ids.length, timestampsUs, codec: 'test-frame-handoff' };
    } };
  const canvas = { getContext: () => ({ putImageData() {} }) };
  const controller = new AbortController();
  return { workflows: createWorkflows(api, canvas, controller.signal, (blob, name) => outputs.push(name)), controller, encoded, outputs, renders: () => renders };
}

test('video encodes the rendered animation frames and preserves its PNG outputs', async () => {
  const original = globalThis.ImageData;
  globalThis.ImageData = class {};
  try {
    const f = fixture();
    await f.workflows.animation(); await f.workflows.video();
    assert.equal(f.renders(), 3, 'Encoding must not render the same animation a second time');
    assert.deepEqual(f.encoded, [[1, 2, 3]]);
    assert.equal(f.outputs.filter(n => n === 'scene.png').length, 6);
    assert.equal(f.outputs.filter(n => n.startsWith('frame-')).length, 3);
    assert.equal(f.outputs.filter(n => n.endsWith('.mp4')).length, 1);
  } finally { globalThis.ImageData = original; }
});

test('an intervening workflow or a consumed sequence requires fresh video frames', async () => {
  const original = globalThis.ImageData;
  globalThis.ImageData = class {};
  try {
    const f = fixture();
    await f.workflows.animation(); await f.workflows.esm(); await f.workflows.video(); await f.workflows.video();
    assert.equal(f.renders(), 9);
    assert.deepEqual(f.encoded, [[4, 5, 6], [7, 8, 9]]);
  } finally { globalThis.ImageData = original; }
});

test('replaying rendered frames still observes cancellation before encoding', async () => {
  const original = globalThis.ImageData;
  globalThis.ImageData = class {};
  try {
    const f = fixture();
    await f.workflows.animation(); f.controller.abort();
    await assert.rejects(f.workflows.video(), { name: 'AbortError' });
    assert.equal(f.renders(), 3); assert.equal(f.encoded.length, 0);
    assert.equal(f.outputs.filter(n => n.endsWith('.mp4')).length, 0);
  } finally { globalThis.ImageData = original; }
});
