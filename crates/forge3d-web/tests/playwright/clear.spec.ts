import { expect, test } from "@playwright/test";

declare global {
  interface Window {
    __forge3dClearProbe: () => Promise<{
      supported: boolean;
      width?: number;
      height?: number;
      nonBlackPixels: number;
    }>;
  }
}

test("clears the canvas through Forge3D WebGPU presentation", async ({
  page
}) => {
  await page.goto("/examples/test-clear.html");

  const result = await page.evaluate(() => window.__forge3dClearProbe());

  expect(result.supported).toBeTruthy();
  expect(result.width).toBe(96);
  expect(result.height).toBe(64);
  expect(result.nonBlackPixels).toBeGreaterThan(100);
});
