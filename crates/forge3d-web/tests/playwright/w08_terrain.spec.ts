import { expect, skipRenderAssertionsWhenProbing, test } from "../browser/webgpu-fixture";

declare global {
  interface Window {
    __forge3dW08: Record<string, (...args: any[]) => Promise<any>>;
  }
}

async function probe(page: import("../browser/webgpu-fixture").Page, name: string): Promise<any> {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/examples/test-w08-terrain.html");
  const result = await page.evaluate((key) => window.__forge3dW08[key]!(), name);
  expect(errors, `page errors in ${name}`).toEqual([]);
  if (process.env.FORGE3D_W08_DEBUG) {
    console.log(name, JSON.stringify(result, null, 1).slice(0, 20000));
  }
  return result;
}

test.describe("W08 terrain clipmap geometry + streamed heightfield", () => {
  test.beforeEach(({ webgpuAvailability }) => {
    skipRenderAssertionsWhenProbing(webgpuAvailability);
  });

  test("E0: capabilities report negotiated W08 limits and feature booleans", async ({ page }) => {
    const r = await probe(page, "capabilities");
    expect(r.deviceState).toBe("ready");
    expect(typeof r.maxSampledTexturesPerShaderStage).toBe("number");
    expect(r.maxSampledTexturesPerShaderStage).toBeGreaterThanOrEqual(16);
    // The clipmap path only needs the WebGPU-default 16 sampled textures;
    // streaming/overlays/VT need the raised limits the adapter supports.
    expect(r.terrainClipmap).toBe(true);
    if (r.maxSampledTexturesPerShaderStage >= 17) {
      expect(r.terrainStreaming).toBe(true);
    }
  });

  test("clipmap renders a steep DEM crack-free in the central region (all clear pixels counted)", async ({
    page,
  }) => {
    test.slow();
    const r = await probe(page, "crack");
    expect(r.report.mode).toBe("clipmap");
    expect(r.report.renderMode).toBe("perspective");
    expect(r.report.triangleBudget).toBeGreaterThan(0);
    expect(r.report.triangleCount).toBe(r.report.triangleBudget);
    expect(r.report.indexCount).toBe(r.report.triangleCount * 3);
    // Every clear-color pixel in the central 60% box is a crack/uncovered
    // region — including 1-px lines the retired enclosed-pixel metric missed.
    for (const render of r.renders) {
      expect(render.centralClear, `${render.name} central clear pixels`).toBe(0);
    }
    // Negative control: the same metric must detect real background.
    expect(r.negativeControl, "past-edge camera should see clear pixels").toBeGreaterThan(0);
  });

  test("grid and clipmap geometry render the same DEM identically near the center", async ({
    page,
  }) => {
    test.slow();
    const r = await probe(page, "gridClipmapParity");
    // World/uv mapping parity: central-region mean abs diff <= 1/255 per
    // channel and SSIM >= 0.99.
    expect(r.meanAbs, `meanAbs=${r.meanAbs}`).toBeLessThanOrEqual(1);
    expect(r.ssim, `ssim=${r.ssim}`).toBeGreaterThanOrEqual(0.99);
  });

  test("converged 1025x1025 streaming matches the dense clipmap render (near rings data lod 0)", async ({
    page,
  }) => {
    test.slow();
    test.setTimeout(300_000);
    const r = await probe(page, "streamingParity");
    // Non-vacuous: the compared central region is all terrain.
    expect(r.centralClear, "central clear pixels").toBe(0);
    expect(r.stats.converged, JSON.stringify(r.stats)).toBe(true);
    expect(r.stats.ringDataLods[0], "ring 0 data lod").toBe(0);
    expect(r.requests).toBeGreaterThan(0);
    expect(r.meanAbs, `meanAbs=${r.meanAbs}`).toBeLessThanOrEqual(1);
    expect(r.ssim, `ssim=${r.ssim}`).toBeGreaterThanOrEqual(0.99);
  });

  test("material + streaming matches the dense material render (SSIM >= 0.99)", async ({ page }) => {
    test.slow();
    test.setTimeout(300_000);
    const r = await probe(page, "materialStreamingParity");
    expect(r.centralClear, "central clear pixels").toBe(0);
    expect(r.stats.converged, JSON.stringify(r.stats)).toBe(true);
    expect(r.stats.ringDataLods[0], "ring 0 data lod").toBe(0);
    expect(r.requests).toBeGreaterThan(0);
    expect(r.materialEffect.byteEqual, "material must change the frame").toBe(false);
    expect(r.ssim, `ssim=${r.ssim} meanAbs=${r.meanAbs}`).toBeGreaterThanOrEqual(0.99);
  });

  test("explicit grid geometry is byte-identical to the default dense path", async ({ page }) => {
    test.slow();
    const r = await probe(page, "gridIdentity");
    expect(r.byteEqual, `maxDiff ${r.maxDiff}`).toBe(true);
  });

  test("streamed 16385x16385 converges in budget; GPU LOD matches the CPU reference", async ({ page }) => {
    test.slow();
    test.setTimeout(300_000);
    const r = await probe(page, "streaming");
    expect(r.maxResident).toBeLessThanOrEqual(r.maxResidentBytes);
    for (const [i, frame] of r.frames.entries()) {
      expect(frame.holes, `fly-through frame ${i} interior hole pixels`).toBe(0);
      expect(frame.residentHeightBytes).toBeLessThanOrEqual(r.maxResidentBytes);
    }
    // The fly-through converges: every planned non-prefetch tile is resident.
    expect(r.frames.at(-1).converged, JSON.stringify(r.convergedStats)).toBe(true);
    // Converged detail differs from the coarse-only base.
    expect(r.convergedDiff.byteEqual).toBe(false);
    expect(r.convergedDiff.maxDiff).toBeGreaterThan(0);
    // GPU LOD selection equals the CPU reference for the same camera.
    expect(r.lodMatch, "GPU LOD readback never landed").not.toBeNull();
    expect(r.lodMatch.equal, JSON.stringify(r.lodMatch)).toBe(true);
  });

  test("device loss + replay of the same inputs and tiles reproduces the frame", async ({ page }) => {
    test.slow();
    test.setTimeout(300_000);
    const r = await probe(page, "deviceLoss");
    expect(r.byteEqual, `maxDiff ${r.maxDiff}`).toBe(true);
  });

  test("clipmap-seam-v1 budget: triangle count is the budget, camera-invariant, overlays deterministic", async ({ page }) => {
    test.slow();
    test.setTimeout(300_000);
    const r = await probe(page, "seamBudget");
    expect(r.cameraCount).toBe(8);
    expect(r.overlayReport.layerCount).toBe(3);
    for (const [i, cam] of r.perCamera.entries()) {
      expect(cam.triangleCount, `camera ${i} triangle count`).toBe(cam.triangleBudget);
      expect(cam.triangleCount).toBe(r.perCamera[0].triangleCount);
      // The runtime enforces the configured budget (not the harness
      // constant), accounts resident bytes per tile, and stays under it.
      expect(cam.statsMaxResidentBytes).toBe(r.maxResidentBytes);
      expect(cam.residentHeightBytes).toBe(cam.residentTiles * cam.tileSize * cam.tileSize * 4);
      expect(cam.residentHeightBytes).toBeLessThanOrEqual(cam.statsMaxResidentBytes);
      // Interior-hole guarantee applies only where the terrain covers the
      // whole frame — at grazing silhouette views a 1-px enclosed clear
      // pixel is a legitimate see-through gap, not a mesh crack (the
      // dedicated crack test owns the whole-frame zero-hole contract).
      if (cam.clearCount === 0) {
        expect(cam.holes, `camera ${i} interior holes`).toBe(0);
      }
    }
    // The strict hole check must actually exercise at least one
    // fully-covered frame, not silently skip every camera.
    expect(
      r.perCamera.filter((cam) => cam.clearCount === 0).length,
    ).toBeGreaterThan(0);
    expect(r.maxResident).toBeLessThanOrEqual(r.maxResidentBytes);
    // The sweep really hits the budget: residency is held by LRU eviction,
    // so the bound above is enforced rather than trivially met.
    expect(r.perCamera.at(-1).evictions).toBeGreaterThan(0);
    expect(r.perCamera.at(-1).converged).toBe(true);
    expect(r.deterministic, "3-overlay re-render").toBe(true);
    // clipmap-seam-v1 budgets (tests/parity/fixture-contracts.json):
    // gpuBytes <= the reference-integrated 1.5 GiB (+5% budgetRelative) —
    // the tighter of the two profiles — measured on the runtime ledger.
    expect(r.peakGpuBytes).toBeGreaterThan(0);
    expect(r.peakGpuBytes).toBeLessThanOrEqual(1610612736 * 1.05);
    // frameTimeP95Ms (16.7 / 33.3 ms) is defined for the reference
    // discrete/integrated hardware profiles over a 600 s soak; these lanes
    // run for seconds on whatever adapter the browser exposes (SwiftShader
    // in CI), so the measured p95 is recorded, not asserted.
    test.info().annotations.push({
      type: "clipmap-seam-v1 frameTimeP95Ms not asserted",
      description: `measured ${r.frameTimeP95Ms.toFixed(1)} ms over ${r.cameraCount} frames on ${JSON.stringify(r.adapter)}; budget applies to reference-discrete/integrated hardware over a 600 s soak`,
    });
  });

  test("E7 wasm helpers: clipmap mesh, reduction and CPU LOD reference", async ({ page }) => {
    const r = await probe(page, "helpers");
    // Known H1 count for (ringCount 4, ringResolution 64, centerResolution 64).
    expect(r.triangleCount).toBe(343264);
    expect(r.ringsCount).toBe(4);
    expect(r.positionsLength).toBe(r.vertexCount * 2);
    expect(r.morphLength).toBe(r.vertexCount * 2);
    expect(r.indicesLength).toBe(r.indexCount);
    expect(r.selection.tiles.length).toBe(2);
    // Exact CPU frustum results: both tiles in front of a camera facing
    // them, none behind one turned away.
    expect(r.selectionFacing.visibleCount, JSON.stringify(r.selectionFacing)).toBe(2);
    expect(r.selectionAway.visibleCount, JSON.stringify(r.selectionAway)).toBe(0);
  });
});
