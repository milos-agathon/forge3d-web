import { expect, test } from "@playwright/test";

declare global {
  interface Window {
    __forge3dTerrainProbe: () => Promise<{
      supported: boolean;
      width: number;
      height: number;
      variedPixels: number;
      lumaRange: number;
      invalidCode?: string;
    }>;
  }
}

test("renders synthetic terrain heightmap with visible variation", async ({
  page
}) => {
  await page.goto("/examples/test-terrain-hill.html");

  const result = await page.evaluate(() => window.__forge3dTerrainProbe());

  expect(result.supported).toBeTruthy();
  expect(result.width).toBe(128);
  expect(result.height).toBe(96);
  expect(result.invalidCode).toBe("INVALID_INPUT");
  expect(result.variedPixels).toBeGreaterThan(1000);
  expect(result.lumaRange).toBeGreaterThan(30);
});
