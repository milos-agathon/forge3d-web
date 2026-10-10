// Test-only negative control: a real synchronous WASM call that never returns.
const dist = new URLSearchParams(location.search).has("dist");
const apiReady = dist ? import("../dist/index.js") : import("../src-ts/index.ts");
const spinBytes = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0,
  1, 4, 1, 96, 0, 0,
  3, 2, 1, 0,
  7, 8, 1, 4, 115, 112, 105, 110, 0, 0,
  10, 9, 1, 7, 0, 3, 64, 12, 0, 11, 11,
]);
self.addEventListener("message", async ({ data }) => {
  if (!data.port) return;
  // Install the listener before dynamic imports yield; the initial port must
  // remain queued while the package graph is loading.
  const api = await apiReady, handler = api.createPointCloudWorkerHandler();
  api.serveForge3DMessagePort(data.port, {
    run: async (payload, context) => {
      if (payload.kind === "test-stuck-wasm") {
        const { instance } = await WebAssembly.instantiate(spinBytes);
        self.postMessage({ state: "stuck-wasm-entered" });
        instance.exports.spin();
        throw new Error("The negative control must never return");
      }
      return handler(payload, context);
    },
  });
});
