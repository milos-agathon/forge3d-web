import { expect, skipRenderAssertionsWhenProbing, test } from "../browser/webgpu-fixture";

declare global {
  interface Window {
    __forge3dW08Overlays: Record<string, (...args: any[]) => Promise<any>>;
  }
}

async function probe(page: import("../browser/webgpu-fixture").Page, name: string): Promise<any> {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/examples/test-w08-overlays.html");
  const result = await page.evaluate((key) => window.__forge3dW08Overlays[key]!(), name);
  expect(errors, `page errors in ${name}`).toEqual([]);
  if (process.env.FORGE3D_W08_DEBUG) {
    console.log(name, JSON.stringify(result, null, 1).slice(0, 20000));
  }
  return result;
}

test.describe("W08 terrain overlays", () => {
  test.beforeEach(({ webgpuAvailability }) => {
    skipRenderAssertionsWhenProbing(webgpuAvailability);
  });

  test("3-layer stack is deterministic, z-order aware and reported", async ({ page }) => {
    test.slow();
    const r = await probe(page, "deterministic");
    expect(r.deterministic.byteEqual, `deterministic maxDiff ${r.deterministic.maxDiff}`).toBe(true);
    expect(r.zOrderDiffers.byteEqual, "swapping zOrder must change the frame").toBe(false);
    expect(r.zOrderDiffers.maxDiff).toBeGreaterThan(0);
    expect(r.report.enabled).toBe(true);
    expect(r.report.layerCount).toBe(3);
    expect(r.report.width).toBeGreaterThan(0);
    expect(r.report.gpuBytes).toBeGreaterThan(0);
    // Planned stack is z-order sorted.
    const modes = r.report.layers.map((l: { blendMode: string }) => l.blendMode);
    expect(modes).toEqual(["normal", "multiply", "overlay"]);
  });

  test("disabled settings and invisible layers are byte-identical to no overlays", async ({
    page,
  }) => {
    test.slow();
    const r = await probe(page, "offIdentity");
    expect(r.disabled.byteEqual, `disabled maxDiff ${r.disabled.maxDiff}`).toBe(true);
    expect(r.invisible.byteEqual, `invisible maxDiff ${r.invisible.maxDiff}`).toBe(true);
    expect(r.report.enabled).toBe(false);
    expect(r.report.layerCount).toBe(0);
  });

  test("overlay albedo matches the core CPU blend reference within 2/255", async ({ page }) => {
    test.slow();
    const r = await probe(page, "albedoParity");
    expect(r.maxDiff, `maxDiff=${r.maxDiff} tolerance=${r.tolerance}`).toBeLessThanOrEqual(
      r.tolerance,
    );
    expect(r.overTolerance, `${r.overTolerance}/${r.channels} channels over tolerance`).toBe(0);
  });

  test("overlays apply before lighting (self-shadowed pixel is darker)", async ({ page }) => {
    test.slow();
    const r = await probe(page, "shadowInteraction");
    expect(r.darkening, JSON.stringify(r)).toBeGreaterThan(0);
    const litSum = r.lit[0] + r.lit[1] + r.lit[2];
    const shadowedSum = r.shadowed[0] + r.shadowed[1] + r.shadowed[2];
    expect(shadowedSum).toBeLessThan(litSum);
  });

  test("EPSG:4326 layer lands at the transformed uv on an EPSG:3857 terrain", async ({
    page,
  }) => {
    test.slow();
    const r = await probe(page, "crsPlacement");
    expect(r.insideDiff, `inside uv ${JSON.stringify(r.uvRect)} rgba ${r.insideRgba}`).toBeGreaterThan(0);
    expect(r.outsideDiff, "pixels outside the layer bounds stay untouched").toBe(0);
  });

  test("unsupported CRS pair is rejected with UNSUPPORTED_FEATURE / crs_mismatch", async ({
    page,
  }) => {
    test.slow();
    const r = await probe(page, "unsupportedCrs");
    expect(r.threw, "expected the commit or render to throw").toBe(true);
    expect(r.code).toBe("UNSUPPORTED_FEATURE");
    expect(r.message).toContain("crs_mismatch");
  });

  for (const probeName of ["viewerDeviceLoss", "sessionDeviceLoss"] as const) {
    test(`${probeName}: overlays replay with the terrain; frame byte-equal`, async ({ page }) => {
      test.slow();
      const r = await probe(page, probeName);
      expect(r.status).toBe("ready");
      // The loss really happened: one recovery (viewer) / a replacement
      // runtime (session).
      if (probeName === "viewerDeviceLoss") {
        expect(r.recoveryAttempts).toBe(1);
      } else {
        expect(r.runtimes).toBe(2);
      }
      expect(r.reportBefore.layerCount, JSON.stringify(r.reportBefore)).toBe(3);
      expect(r.reportAfter, JSON.stringify(r.reportAfter)).toEqual(r.reportBefore);
      expect(r.diff.byteEqual, JSON.stringify(r.diff)).toBe(true);
    });
  }
});
