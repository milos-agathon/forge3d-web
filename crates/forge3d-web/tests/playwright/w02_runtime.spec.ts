import {
  expect,
  skipRenderAssertionsWhenProbing,
  test,
} from "../browser/webgpu-fixture";

declare global {
  interface Window {
    __forge3dW02Probe: () => Promise<any>;
    __forge3dW02LossProbe: (cycles?: number) => Promise<any>;
  }
}

test("W02 runtime integrates session, offscreen, and worker paths", async ({
  page,
  webgpuAvailability,
}) => {
  // Creates several WebGPU runtimes; each compiles the W04 shared-lighting
  // terrain/scene pipelines, which uncached CI GPUs compile slowly.
  test.slow();
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });

  await page.goto("/examples/test-w02-runtime.html");
  const result = await page.evaluate(() => window.__forge3dW02Probe());

  expect(result.supported).toBe(true);

  expect(result.main.rendered).toBe(true);
  expect(result.main.rgbaBytes).toBe(96 * 64 * 4);
  expect(result.main.rgbaAlpha).toBeGreaterThan(0);

  const { capabilities } = result;
  expect(typeof capabilities.adapterInfo.name).toBe("string");
  expect(typeof capabilities.adapterInfo.vendor).toBe("string");
  expect(typeof capabilities.adapterInfo.backend).toBe("string");
  expect(typeof capabilities.adapterInfo.deviceType).toBe("string");
  expect(typeof capabilities.isFallbackAdapter).toBe("boolean");
  expect(capabilities.limits.maxTextureDimension2D).toBeGreaterThan(0);
  expect(capabilities.limits.maxBufferSize).toBeGreaterThan(0);
  expect(capabilities.limits.maxBindGroups).toBeGreaterThan(0);
  expect(Array.isArray(capabilities.features)).toBe(true);
  expect(Array.isArray(capabilities.surfaceFormats)).toBe(true);
  expect(capabilities.surfaceFormats.length).toBeGreaterThan(0);
  expect(capabilities.surfaceFormat.length).toBeGreaterThan(0);
  expect(capabilities.preferredCanvasFormat.length).toBeGreaterThan(0);
  expect(typeof capabilities.timestampQuery).toBe("boolean");
  expect(["gpu-timestamp", "cpu"]).toContain(capabilities.timingMode);
  expect(typeof capabilities.offscreenCanvas).toBe("boolean");
  expect(capabilities.offscreenCanvas).toBe(true);
  expect(capabilities.workers).toBe(true);
  expect(typeof capabilities.sharedArrayBuffer).toBe("boolean");
  expect(typeof capabilities.fileSystemAccess).toBe("boolean");
  expect(typeof capabilities.opfs).toBe("boolean");

  expect(result.planPasses).toEqual(
    expect.arrayContaining([
      "terrain",
      "ground-plane",
      "text-mesh",
      "overlay",
      "custom-noop",
    ]),
  );
  const statPasses = result.stats.passes.map((pass: any) => pass.name);
  expect(statPasses).toEqual(
    expect.arrayContaining([
      "terrain",
      "ground-plane",
      "text-mesh",
      "overlay",
      "custom-noop",
    ]),
  );
  expect(result.stats.triangles).toBeGreaterThan(0);
  for (const pass of result.stats.passes) {
    expect(Number.isFinite(pass.milliseconds)).toBe(true);
    expect(pass.milliseconds).toBeGreaterThanOrEqual(0);
    expect(["gpu-timestamp", "cpu"]).toContain(pass.timing);
  }

  expect(result.memory.budgetBytes).toBe(512 * 1024 * 1024);
  expect(Object.keys(result.memory.categories).sort()).toEqual([
    "buffers",
    "other",
    "readback",
    "render-bundles",
    "staging",
    "textures",
    "tile-cache",
  ]);
  expect(result.memory.currentBytes).toBeGreaterThan(0);

  const { offscreen } = result;
  expect(offscreen.rendered).toBe(true);
  expect(offscreen.rgbaBytes).toBe(96 * 64 * 4);
  expect(offscreen.rgbaAlpha).toBeGreaterThan(0);
  expect(offscreen.rgbaWidth).toBe(96);
  expect(offscreen.rgbaHeight).toBe(64);
  expect(offscreen.blobType).toBe("image/png");
  expect(offscreen.blobSize).toBeGreaterThan(0);
  expect(offscreen.bitmap.width).toBe(96);
  expect(offscreen.bitmap.height).toBe(64);
  expect(offscreen.streamBytes).toBeGreaterThan(0);
  expect(offscreen.streamChunks).toBeGreaterThan(0);
  expect(offscreen.disposed).toBe(true);

  const { worker } = result;
  expect(worker.rendered).toBe(true);
  expect(worker.rgbaBytes).toBe(96 * 64 * 4);
  expect(worker.rgbaAlpha).toBeGreaterThan(0);
  expect(worker.blobType).toBe("image/png");
  expect(worker.blobSize).toBeGreaterThan(0);
  expect(worker.diagnostics.disposed).toBe(false);
  expect(typeof worker.diagnostics.stateHash).toBe("string");
  expect(worker.disposedDiagnostics.disposed).toBe(true);
  expect(worker.disposedDiagnostics.ownedListeners).toBe(0);
  expect(worker.disposedDiagnostics.activePointers).toBe(0);
  expect(worker.disposedDiagnostics.activeObservers).toBe(0);

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test("survives 30 create/render/loss/dispose cycles without leaks", async ({
  page,
  webgpuAvailability,
}) => {
  // Creates several WebGPU runtimes; each compiles the W04 shared-lighting
  // terrain/scene pipelines, which uncached CI GPUs compile slowly.
  test.slow();
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/examples/test-w02-runtime.html");
  const result = await page.evaluate(() => window.__forge3dW02LossProbe(30));

  expect(result.supported).toBe(true);
  expect(result.ok).toBe(true);
  expect(result.cycles).toBe(30);
  expect(result.activeRuntimes).toBe(0);
  expect(result.nativeMemory.currentBytes).toBe(0);
  expect(result.nativeMemory.allocationCount).toBe(0);
  for (const bytes of Object.values(result.nativeMemory.categories)) {
    expect(bytes).toBe(0);
  }
  expect(result.sessionMemory.currentBytes).toBe(0);
  expect(result.sessionMemory.allocationCount).toBe(0);
  for (const bytes of Object.values(result.sessionMemory.categories)) {
    expect(bytes).toBe(0);
  }
  expect(pageErrors).toEqual([]);
});
