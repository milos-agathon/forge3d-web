import {
  test,
  expect,
  skipRenderAssertionsWhenProbing,
} from "../browser/webgpu-fixture";
declare global {
  interface Window {
    __w15: any;
  }
}
for (const dist of [false, true]) {
  const mode = dist ? "dist" : "source";
  const open = async (page: any) => {
    await page.goto(`/examples/mesh-buildings.html${dist ? "?dist" : ""}`);
    await page.waitForFunction(() => !!window.__w15);
  };
  test(`W15 ${mode}: browser format fidelity, image/HDR IO and typed failures`, async ({
    page,
  }) => {
    await open(page);
    const r = await page.evaluate(() => window.__w15.io());
    expect(r.familyRoundtrips).toHaveLength(15);
    for (const copy of r.familyRoundtrips) {
      expect(copy.triangles).toBe(copy.expectedTriangles);
      expect(copy.vertices).toBe(copy.expectedVertices);
      expect(copy.topology).toBe(true);
      for (const key of [
        "positionError",
        "boundsError",
        "normalError",
        "uvError",
        "tangentError",
      ])
        if (copy[key] !== null) expect(copy[key]).toBeLessThanOrEqual(1e-5);
    }
    expect(r.plainCounts).toEqual([1, 1, 1]);
    expect(r.mtl).toBe("facade.png");
    expect(r.pngExact).toBe(true);
    expect(r.hdrError).toBeLessThanOrEqual(1e-5);
    for (const copy of r.roundtrips) {
      expect(copy.vertices).toBe(3);
      expect(copy.triangles).toBe(1);
      expect(copy.topology).toBe(true);
      expect(copy.positionError).toBeLessThanOrEqual(1e-5);
      expect(copy.normalError).toBeLessThanOrEqual(1e-5);
      if (copy.uvError !== null) expect(copy.uvError).toBeLessThanOrEqual(1e-5);
    }
    expect(r.cancelled).toBe("REQUEST_CANCELLED");
    expect(r.budget).toBe("RESOURCE_LIMIT_EXCEEDED");
    expect(r.diagnostics.status).toBe("error");
    expect(r.diagnostics.texturedMaterialStatus).toBe("placeholder/fallback");
  });
  test(`W15 ${mode}: real worker transfers both directions`, async ({
    page,
  }) => {
    await open(page);
    const r = await page.evaluate(() => window.__w15.worker());
    expect(
      r.inputDetached && r.ownedIntact && r.returnedDetached && r.valid,
    ).toBe(true);
    expect(r.mode).toBe("transferable");
    expect(r.triangles).toBe(128);
    expect(r.vertices).toBe(81);
  });
  test(`W15 ${mode}: visible buildings, scalar material slots and LOD`, async ({
    page,
    webgpuAvailability,
  }) => {
    skipRenderAssertionsWhenProbing(webgpuAvailability);
    await open(page);
    const r = await page.evaluate(() => window.__w15.buildings());
    expect(Object.keys(r.counts)).toHaveLength(2);
    for (const count of Object.values(r.counts))
      expect(count).toBeGreaterThan(100);
    expect(r.materialIndices).toEqual([2, 3]);
    expect(r.projectedBounds.min[0]).toBeCloseTo(0, 4);
    expect(r.projectedBounds.max[0]).toBeGreaterThan(3000);
    expect(r.projectedBounds.max[2]).toBe(4);
    expect(r.triangles).toBe(24);
    expect(r.cityBounds).toEqual({ min: [0, 0, 0], max: [2, 1.5, 2] });
    expect(r.near.lodInstanceCounts[0]).toBe(2);
    expect(r.far.lodInstanceCounts[1]).toBe(2);
    const colors = Object.values(r.colors) as number[][];
    expect(Math.abs(colors[0]![0]! - colors[1]![0]!)).toBeGreaterThan(0.05);
  });
  test(`W15 ${mode}: UV textures and instanced TBN match transformed mesh`, async ({
    page,
    webgpuAvailability,
  }) => {
    skipRenderAssertionsWhenProbing(webgpuAvailability);
    await open(page);
    const r = await page.evaluate(() => window.__w15.textures());
    expect(r.covered).toBeGreaterThan(100);
    expect(r.colors).toBeGreaterThan(3);
    expect(r.normalError).toBeLessThanOrEqual(1e-5);
    expect(r.albedoError).toBeLessThanOrEqual(1e-5);
    expect(r.idsEqual).toBe(true);
    expect(r.uvNegativeDelta).toBeGreaterThan(0.1);
  });
  test(`W15 ${mode}: replacement, budget failure and resize`, async ({
    page,
    webgpuAvailability,
  }) => {
    skipRenderAssertionsWhenProbing(webgpuAvailability);
    await open(page);
    const r = await page.evaluate(() => window.__w15.resources());
    expect(r.stable && r.atomic).toBe(true);
    expect(r.bytes).toBeGreaterThan(0);
    expect(r.rejected).toBe("RESOURCE_LIMIT_EXCEEDED");
    expect(r.resized).toBe(128 * 80 * 4);
    expect(r.cleared).toBe(0);
  });
  test(`W15 ${mode}: device loss replays imported building geometry and materials`, async ({
    page,
    webgpuAvailability,
  }) => {
    skipRenderAssertionsWhenProbing(webgpuAvailability);
    await open(page);
    const r = await page.evaluate(() => window.__w15.recovery());
    expect(r.same).toBe(true);
    expect(r.created).toBe(2);
    expect(r.status).toBe("ready");
    expect(r.stats.visibleInstances).toBe(2);
  });
}
