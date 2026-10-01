import {
  expect,
  skipRenderAssertionsWhenProbing,
  test,
} from "../browser/webgpu-fixture";
declare global {
  interface Window {
    __w10: Record<string, () => Promise<any>>;
  }
}
for (const dist of [false, true])
  test(`W10 sky, fog, volumes, deterministic clouds and water (${dist ? "dist" : "source"})`, async ({
    page,
    webgpuAvailability,
  }) => {
    skipRenderAssertionsWhenProbing(webgpuAvailability);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/examples/test-w10.html" + (dist ? "?dist" : ""));
    await page.waitForFunction(() => window.__w10 !== undefined);
    const r = await page.evaluate(() => window.__w10.render!());
    expect(r.covered).toBeGreaterThan(1000);
    expect(r.generalCovered).toBeGreaterThan(1000);
    expect(r.generalDelta).toBeGreaterThan(0.1);
    for (const name of ["sky", "fog", "volume", "cloud", "water"]) {
      expect(r[name].delta).toBeGreaterThan(0.1);
      expect(r[name].report.gpuBytes).toBeGreaterThan(0);
    }
    expect(r.cloud.timeDelta).toBeGreaterThan(0.01);
    expect(r.cloud.hash).toBe(r.cloud.repeat);
    expect(r.plain).toBe(r.cleared);
    expect(r.released).toBe(0);
    expect(errors).toEqual([]);
  });
test("W10 density volumes have no contribution outside their bounds", async ({
  page,
  webgpuAvailability,
}) => {
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  await page.goto("/examples/test-w10.html");
  await page.waitForFunction(() => window.__w10 !== undefined);
  const r = await page.evaluate(() => window.__w10.bounds!());
  expect(r.max).toBeLessThanOrEqual(1);
  expect(r.outsideMax).toBeLessThanOrEqual(1);
  expect(r.outsidePixels).toBeGreaterThan(10000);
  expect(r.insideChanged).toBeGreaterThan(20);
});
test("W10 explicit water and foam masks affect covered pixels", async ({
  page,
  webgpuAvailability,
}) => {
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  await page.goto("/examples/test-w10.html");
  await page.waitForFunction(() => window.__w10 !== undefined);
  const r = await page.evaluate(() => window.__w10.masks!());
  for (const name of ["water-mask", "foam", "reflection"])
    expect(r.frames[name].nonzero).toBeGreaterThan(20);
  expect(r.zero).toBe(0);
  expect(r.transparent).toBe(true);
});
test("W10 budget rejection is atomic and resize retains accounted resources", async ({
  page,
  webgpuAvailability,
}) => {
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  await page.goto("/examples/test-w10.html");
  await page.waitForFunction(() => window.__w10 !== undefined);
  const r = await page.evaluate(() => window.__w10.budget!());
  expect(r.code).toBe("RESOURCE_LIMIT_EXCEEDED");
  expect(r.before).toBe(r.after);
  expect(r.bytes).toBe(r.afterBytes);
  expect(r.report.width).toBe(224);
  expect(r.report.height).toBe(144);
  expect(r.ledger.currentBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
  expect(r.released).toBe(0);
});
test("W10 scene atmosphere applies to offline HDR capture", async ({
  page,
  webgpuAvailability,
}) => {
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  await page.goto("/examples/test-w10.html");
  await page.waitForFunction(() => window.__w10 !== undefined);
  const r = await page.evaluate(() => window.__w10.offline!());
  expect(r.nonzero).toBe(true);
  expect(r.captureRepeat).toBe(true);
  expect(r.report.waterCount).toBe(1);
  expect(r.waterIds).toEqual([4294967280]);
});
test("W10 viewer replays environment after device loss", async ({
  page,
  webgpuAvailability,
}) => {
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  await page.goto("/examples/test-w10.html");
  await page.waitForFunction(() => window.__w10 !== undefined);
  const r = await page.evaluate(() => window.__w10.recovery!());
  expect(r.same).toBe(true);
  expect(r.attempts).toBe(1);
  expect(r.report.waterCount).toBe(1);
});
test("W10 half resolution, froxel, temporal reset and occluded light shafts", async ({
  page,
  webgpuAvailability,
}) => {
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  await page.goto("/examples/test-w10.html");
  await page.waitForFunction(() => window.__w10 !== undefined);
  const r = await page.evaluate(() => window.__w10.quality!());
  expect(r.halfDelta).toBeLessThan(2);
  expect(r.froxelDelta).toBeLessThan(1);
  expect(r.froxelReport.gpuBytes).toBeGreaterThan(192 * 128 * 24);
  expect(r.valid).toBe(true);
  expect(r.cameraReset).toBe(false);
  expect(r.freshDelta).toBeLessThan(1);
  expect(r.occlusionDelta).toBeGreaterThan(0.01);
  expect(r.darkened).toBeGreaterThan(100);
});
test("W10 native sky, cloud scattering and water wave image probes", async ({
  page,
  webgpuAvailability,
}) => {
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  await page.goto("/examples/test-w10.html");
  await page.waitForFunction(() => window.__w10 !== undefined);
  const cases = await page.evaluate(() => window.__w10.native!());
  expect(cases).toHaveLength(6);
  for (const c of cases) {
    expect(c.maxAbs, c.name).toBeLessThan(1e-3);
    expect(c.ssim, c.name).toBeGreaterThanOrEqual(0.98);
    expect(c.controlSsim, c.name).toBeLessThan(0.98);
  }
});
test("W10 environment scene survives worker serialization and UTC animation", async ({
  page,
  webgpuAvailability,
}) => {
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  await page.goto("/examples/test-w10.html");
  await page.waitForFunction(() => window.__w10 !== undefined);
  const r = await page.evaluate(() => window.__w10.worker!());
  expect(r.covered).toBeGreaterThan(1000);
  expect(r.delta).toBeGreaterThan(0.1);
});
test("W10 downscale admission and rejected resize preserve the committed frame", async ({
  page,
  webgpuAvailability,
}) => {
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  await page.goto("/examples/test-w10.html");
  await page.waitForFunction(() => window.__w10 !== undefined);
  const r = await page.evaluate(() => window.__w10.downscale!());
  expect(r.selected.resolutionScale).toBe(0.5);
  expect(r.selected.steps).toBe(32);
  expect(r.code).toBe("RESOURCE_LIMIT_EXCEEDED");
  expect(r.before).toBe(r.after);
  expect(r.bytes).toBe(r.afterBytes);
});
test("W10 cloud modes, terrain shadows, planar reflections and waves", async ({
  page,
  webgpuAvailability,
}) => {
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  await page.goto("/examples/test-w10.html");
  await page.waitForFunction(() => window.__w10 !== undefined);
  const r = await page.evaluate(() => window.__w10.cloudsAndWaves!());
  expect(r.modes.billboard).not.toBe(r.modes.volumetric);
  expect(r.firstSeed).not.toBe(r.secondSeed);
  expect(r.shadowDelta).toBeGreaterThan(0.1);
  expect(r.planarDelta).toBeGreaterThan(0.01);
  expect(r.waveDelta).toBeGreaterThan(0.01);
});
import { writeFileSync } from "node:fs";
test("W10 rendered sky, cloud and water golden images", async ({
  page,
  webgpuAvailability,
}) => {
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  await page.goto("/examples/test-w10.html");
  await page.waitForFunction(() => window.__w10 !== undefined);
  if (process.env.W10_CAPTURE_GOLDENS === "1") {
    const frame = await page.evaluate(() => window.__w10.frames!());
    for (const [name, values] of Object.entries(frame.images)) {
      writeFileSync(
        new URL(`../golden/w10/${name}.rgba`, import.meta.url),
        Buffer.from(values as number[]),
      );
      writeFileSync(
        new URL(`../golden/w10/${name}.png`, import.meta.url),
        Buffer.from(frame.pngs[name]),
      );
    }
  }
  const r = await page.evaluate(() => window.__w10.goldens!());
  expect(r.cloud.disabledSsim).toBeLessThan(0.98);
  expect(r.water.disabledSsim).toBeLessThan(0.98);
  for (const value of Object.values(r) as any[]) {
    expect(value.ssim).toBeGreaterThanOrEqual(0.98);
    expect(value.controlSsim).toBeLessThan(0.98);
  }
});

test("W10 clearing scene or runtime environments restores authoring lights after resize", async ({
  page,
  webgpuAvailability,
}) => {
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  await page.goto("/examples/test-w10.html");
  await page.waitForFunction(() => window.__w10 !== undefined);
  const r = await page.evaluate(() => window.__w10.restoreLights!());
  expect(r.sun).not.toBe(r.baseline);
  expect(r.cleared).toBe(r.baseline);
  expect(r.sceneCleared).toBe(r.baseline);
});
test("W10 sky, clouds, froxel and planar water fit 16 sampled-texture devices", async ({
  page,
  webgpuAvailability,
}) => {
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  await page.addInitScript(() => {
    const original = GPU.prototype.requestAdapter;
    GPU.prototype.requestAdapter = async function (...args) {
      const adapter = await original.apply(this, args);
      if (adapter) {
        const actual = adapter.limits;
        const limits: Record<string, number> = {};
        for (const key in actual) limits[key] = (actual as any)[key];
        limits.maxSampledTexturesPerShaderStage = 16;
        Object.defineProperty(adapter, "limits", {
          value: limits,
          configurable: true,
        });
      }
      return adapter;
    };
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/examples/test-w10.html?dist");
  await page.waitForFunction(() => window.__w10 !== undefined);
  const r = await page.evaluate(async () => ({
    render: await window.__w10.render!(),
    quality: await window.__w10.quality!(),
  }));
  expect(r.render.water.delta).toBeGreaterThan(0.1);
  expect(r.quality.froxelDelta).toBeLessThan(1);
  expect(errors).toEqual([]);
});
