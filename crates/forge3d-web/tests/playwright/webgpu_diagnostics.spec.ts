import { expect, test } from "@playwright/test";

test("reports browser WebGPU diagnostics", async ({ browserName, page }) => {
  await page.goto("/examples/test-clear.html");

  const diagnostics = await page.evaluate(async () => {
    const gpu = navigator.gpu;
    const adapter = gpu ? await gpu.requestAdapter() : null;

    return {
      hasNavigatorGpu: Boolean(gpu),
      adapterAvailable: Boolean(adapter),
      browserUserAgent: navigator.userAgent
    };
  });

  console.info("Forge3D WebGPU diagnostics", {
    browserName,
    ...diagnostics
  });

  expect(diagnostics.hasNavigatorGpu).toBeTruthy();
  expect(diagnostics.adapterAvailable).toBeTruthy();
});
