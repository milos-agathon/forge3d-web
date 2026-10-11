// Test-only observation of the production decoder's actual Module.HEAPU8.
// Firefox worker module imports bypass Playwright page/context routing, so the
// observer lives in the owned worker rather than rewriting the codec response.
const query = new URLSearchParams(location.search), cachedControl = query.has("cached");
const memories = new Set(), modules = new Map(), buffers = new Map(), memoryIds = new Map(), observations = [];
let latestModule;
const instantiate = WebAssembly.instantiate.bind(WebAssembly);
WebAssembly.instantiate = async (...args) => {
  const result = await instantiate(...args), instance = result.instance ?? result;
  for (const value of Object.values(instance.exports)) if (value instanceof WebAssembly.Memory) memories.add(value);
  return result;
};
// Observing exports alone would miss a reused module whose memory.grow replaces
// its buffer. This narrow setter captures the real HEAPU8 assigned by the
// unmodified factory, including subsequent view updates after growth. It changes
// neither the assigned view nor native allocation/decoding behavior.
Object.defineProperty(Object.prototype, "HEAPU8", {
  configurable: true,
  set(initial) {
    if (!(initial instanceof Uint8Array)) throw Error("Unexpected codec HEAPU8 assignment");
    let heap = initial;
    const module = this;
    if (!modules.has(module)) modules.set(module, modules.size + 1);
    latestModule = module;
    Object.defineProperty(module, "HEAPU8", {
      configurable: true, enumerable: true,
      get: () => heap,
      set: value => { heap = value; latestModule = module; },
    });
  },
});
function observe() {
  const heap = latestModule?.HEAPU8, memory = [...memories].find(value => value.buffer === heap?.buffer);
  if (!(heap instanceof Uint8Array) || !memory || heap.byteOffset !== 0 || heap.byteLength !== memory.buffer.byteLength)
    throw Error("Production codec HEAPU8 does not match an observed native memory");
  if (!buffers.has(heap.buffer)) buffers.set(heap.buffer, buffers.size + 1);
  if (!memoryIds.has(memory)) memoryIds.set(memory, memoryIds.size + 1);
  observations.push({ module: modules.get(latestModule), memory: memoryIds.get(memory),
    buffer: buffers.get(heap.buffer), heapBytes: heap.byteLength });
}
// Negative control reproduces the removed module cache: decode the second real
// fixture using the actual native module retained from the first production job.
// Its complete point output must still match the oracle while freshness fails.
function decodeCachedFile(api, bytes, context) {
  const module = latestModule, header = api.parseLasHeader(bytes);
  let input = 0, output = 0, decoder;
  try {
    input = module._malloc(bytes.length + 64); output = module._malloc(header.recordLength);
    if (!input || !output) throw Error("Cached control native allocation failed");
    module.HEAPU8.fill(0, input, input + bytes.length + 64); module.HEAPU8.set(bytes, input);
    decoder = new module.LASZip(); decoder.open(input, bytes.length);
    if (decoder.getCount() !== header.pointCount || decoder.getPointLength() !== header.recordLength || decoder.getPointFormat() !== header.pointFormat)
      throw Error("Cached control header/decoder mismatch");
    const raw = new Uint8Array(header.pointCount * header.recordLength);
    for (let i = 0; i < header.pointCount; i++) {
      decoder.getPoint(output);
      raw.set(module.HEAPU8.subarray(output, output + header.recordLength), i * header.recordLength);
    }
    return api.parseLasRecords(raw, header.pointCount, header, { signal: context.signal });
  } finally {
    decoder?.delete(); if (output) module._free(output); if (input) module._free(input);
  }
}
const apiReady = query.has("dist") ? import("../dist/index.js") : import("../src-ts/index.ts");
self.addEventListener("message", async ({ data }) => {
  if (!data.port) return;
  const api = await apiReady, handler = api.createPointCloudWorkerHandler();
  api.serveForge3DMessagePort(data.port, {
    run: async (request, context) => {
      if (request.kind === "test-heap-observations") return observations;
      const points = cachedControl && latestModule && request.kind === "laz-file"
        ? decodeCachedFile(api, request.bytes, context) : await handler(request, context);
      observe(); return points;
    },
  });
});
