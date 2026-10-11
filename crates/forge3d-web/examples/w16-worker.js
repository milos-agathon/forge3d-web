const apiReady = new URLSearchParams(location.search).has("dist")
  ? import("../dist/index.js")
  : import("../src-ts/index.ts");
self.onmessage = async ({ data }) => {
  if (!data.port) return;
  const api = await apiReady;
  api.serveForge3DMessagePort(data.port, {
    run: api.createPointCloudWorkerHandler(),
  });
};
