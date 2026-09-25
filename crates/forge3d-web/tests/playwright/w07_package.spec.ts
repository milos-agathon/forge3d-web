import {
  expect,
  skipRenderAssertionsWhenProbing,
  test,
} from "../browser/webgpu-fixture";

declare global {
  interface Window {
    __forge3dW07PackageProbe: () => Promise<any>;
  }
}

test("W07 public-API consumer: terrain PBR/POM material, layers and report", async ({
  page,
  webgpuAvailability,
}) => {
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/examples/test-w07-package.html");
  const result = await page.evaluate(() => window.__forge3dW07PackageProbe());

  expect(result.supported).toBe(true);
  expect(result.error).toBeUndefined();
  expect(result.ok).toBe(true);
  expect(result.defaults).toEqual({ albedoMode: "colormap", pom: false });
  expect(result.rejection).toBe("INVALID_INPUT");
  // The zero-feature material reproduces the unmaterialed frame.
  expect(result.zeroMaxDiff).toBeLessThanOrEqual(1);
  expect(result.fullDelta).toBeGreaterThan(1);
  expect(result.report.enabled).toBe(true);
  expect(result.report.layerCount).toBe(2);
  expect(result.report.texturedLayers).toEqual([true, false]);
  expect(result.report.maskChannels).toEqual(["wetness"]);
  expect(result.report.gpuBytes).toBeGreaterThan(0);
  expect(pageErrors).toEqual([]);
});
