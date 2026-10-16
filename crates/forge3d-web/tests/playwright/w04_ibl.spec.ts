import {
  expect,
  skipRenderAssertionsWhenProbing,
  test,
} from "../browser/webgpu-fixture";

declare global {
  interface Window {
    __forge3dW04IblProbe: () => Promise<any>;
  }
}

test("W04 IBL precompute, cache, render, and loss recovery", async ({
  page,
  webgpuAvailability,
}) => {
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });

  await page.goto("/examples/test-w04-ibl.html");
  const result = await page.evaluate(() => window.__forge3dW04IblProbe());

  expect(result.supported).toBe(true);
  expect(result.error).toBeUndefined();
  expect(result.ok).toBe(true);

  expect(result.decoded.width).toBe(8);
  expect(result.decoded.height).toBe(4);
  expect(result.decoded.first[0]).toBeCloseTo(255 * 2 ** (131 - 136), 4);
  expect(result.decoded.first[3]).toBe(1);
  expect(result.decoded.last[2]).toBeCloseTo(200 * 2 ** (129 - 136), 4);

  expect(result.cache.backend).toBe("cache-storage");
  expect(result.cache.firstHit).toBe(false);
  expect(result.cache.secondHit).toBe(true);
  expect(result.cache.identical).toBe(true);
  expect(result.cache.preparedBytes).toBeGreaterThan(0);

  expect(result.report.requestedQuality).toBe("low");
  expect(result.report.effectiveQuality).toBe("low");
  expect(result.report.effectiveMode).toBe("prepared-upload");
  expect(result.report.brdfApproximation).toBe("split-sum-ggx");
  expect(result.report.cacheBackend).toBe("cache-storage");

  expect(result.intensity.disabledVsHalf.changedFraction).toBeGreaterThan(0);
  expect(result.intensity.halfVsFull.changedFraction).toBeGreaterThan(0);
  expect(result.intensity.luminance.full).toBeGreaterThan(
    result.intensity.luminance.half,
  );
  expect(result.intensity.luminance.half).toBeGreaterThan(
    result.intensity.luminance.disabled,
  );

  expect(result.rotation.changedFraction).toBeGreaterThan(0);
  expect(result.roughness.changedFraction).toBeGreaterThan(0);

  expect(result.memory.sessionIncrease).toBeGreaterThan(0);
  expect(result.memory.nativeIncrease).toBeGreaterThan(0);
  expect(result.memory.retainedIbl).toBeLessThanOrEqual(64 * 1024 * 1024);

  expect(result.recovered.status).toBe("ready");
  expect(result.recovered.generations).toBe(2);
  expect(result.recovered.byteEqual).toBe(true);

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
