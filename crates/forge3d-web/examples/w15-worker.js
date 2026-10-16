const apiReady = new URLSearchParams(location.search).has("dist")
  ? import("../dist/index.js")
  : import("../src-ts/index.ts");
self.onmessage = async ({ data }) => {
  const api = await apiReady;
  if (!data.port) return;
  const handler = api.createMeshWorkerHandler();
  api.serveForge3DMessagePort(data.port, {
    run: async (request, context) => {
      const result = await handler(request, context);
      // The server sends the result first, so these bytes must be detached.
      setTimeout(
        () =>
          self.postMessage({
            returnedDetached: result.positions.byteLength === 0,
          }),
        0,
      );
      return result;
    },
  });
};
