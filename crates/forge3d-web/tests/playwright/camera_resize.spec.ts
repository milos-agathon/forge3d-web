import { expect, test } from "@playwright/test";

declare global {
  interface Window {
    __forge3dCameraResizeProbe: () => Promise<{
      supported: boolean;
      width: number;
      height: number;
      resizedWidth: number;
      resizedHeight: number;
      invalidCode?: string;
      changedPixels: number;
    }>;
  }
}

test("resizes canvas backing store by DPR and camera changes terrain pixels", async ({
  page
}) => {
  await page.goto("/examples/test-camera-resize.html");

  const result = await page.evaluate(() => window.__forge3dCameraResizeProbe());

  expect(result.supported).toBeTruthy();
  expect(result.width).toBe(192);
  expect(result.height).toBe(144);
  expect(result.resizedWidth).toBe(192);
  expect(result.resizedHeight).toBe(144);
  expect(result.invalidCode).toBe("INVALID_INPUT");
  expect(result.changedPixels).toBeGreaterThan(250);
});
