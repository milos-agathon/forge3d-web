// Diagnostic-only worker: run the production handler and observe its actual
// memory. No altered codec, allocation cap, or synthetic decoder is substituted.
let currentMemory, peakWasmBytes = 0;
function observe(memory) {
  if (!(memory instanceof WebAssembly.Memory)) return;
  currentMemory = memory;
  peakWasmBytes = Math.max(peakWasmBytes, memory.buffer.byteLength);
  self.postMessage({ fuzzMemoryBytes: peakWasmBytes });
}
const instantiate = WebAssembly.instantiate.bind(WebAssembly);
WebAssembly.instantiate = async (...args) => {
  const result = await instantiate(...args);
  const instance = result.instance ?? result;
  for (const value of Object.values(instance.exports)) observe(value);
  return result;
};
const grow = WebAssembly.Memory.prototype.grow;
WebAssembly.Memory.prototype.grow = function (...args) {
  const result = grow.apply(this, args);
  observe(this);
  return result;
};
const apiReady = import('../dist/index.js');
self.onmessage = async ({ data }) => {
  if (!data.port) return;
  const api = await apiReady, handler = api.createPointCloudWorkerHandler();
  api.serveForge3DMessagePort(data.port, { run: async (request, context) => {
    try {
      const points = await handler(request, context);
      observe(currentMemory);
      return { points, peakWasmBytes };
    } catch (error) {
      observe(currentMemory);
      throw error;
    }
  }});
};
