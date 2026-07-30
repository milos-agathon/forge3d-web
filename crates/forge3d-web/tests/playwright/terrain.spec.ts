import { expect, test } from "../browser/webgpu-fixture";

declare global {
  interface Window {
    __forge3dTerrainProbe: () => Promise<{
      supported: boolean;
      width: number;
      height: number;
      visibleNonTransparentPixels: number;
      variedPixels: number;
      lumaRange: number;
      invalidCode?: string;
    }>;
    __forge3dReliefShadingProbe: () => Promise<{
      supported: boolean;
      visibleTerrainPixels: number;
      terrainLumaRange: number;
      terrainLumaStdDev: number;
    }>;
    __forge3dTerrainEdgeProbe: () => Promise<{
      supported: boolean;
      visibleTerrainPixels: number;
      outerFrameTerrainShare: number;
      rightFrameContactRows: number;
      bottomFrameContactColumns: number;
    }>;
  }
}

test("renders synthetic terrain heightmap with visible variation", async ({
  page
}) => {
  const validationMessages: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (
      text.includes("forge3d-web-terrain-color-ramp-uniform") ||
      text.includes("buffer binding at least 160 bytes") ||
      text.includes("bound with size 144")
    ) {
      validationMessages.push(text);
    }
  });

  await page.goto("/examples/test-terrain-hill.html");

  const result = await page.evaluate(() => window.__forge3dTerrainProbe());

  expect(result.supported).toBeTruthy();
  expect(result.width).toBe(128);
  expect(result.height).toBe(96);
  expect(result.invalidCode).toBe("INVALID_INPUT");
  expect(result.visibleNonTransparentPixels).toBeGreaterThan(1000);
  expect(result.variedPixels).toBeGreaterThan(1000);
  expect(result.lumaRange).toBeGreaterThan(30);
  expect(validationMessages).toEqual([]);
});

test("shades single-color terrain by surface relief", async ({ page }) => {
  await page.goto("/examples/test-terrain-hill.html");

  const result = await page.evaluate(() =>
    window.__forge3dReliefShadingProbe()
  );

  expect(result.supported).toBeTruthy();
  expect(result.visibleTerrainPixels).toBeGreaterThan(1000);
  expect(result.terrainLumaRange).toBeGreaterThan(28);
  expect(result.terrainLumaStdDev).toBeGreaterThan(6);
});

test("softens oblique terrain boundaries instead of exposing rectangular slab edges", async ({
  page
}) => {
  await page.goto("/examples/test-terrain-hill.html");

  const result = await page.evaluate(() =>
    window.__forge3dTerrainEdgeProbe()
  );

  expect(result.supported).toBeTruthy();
  expect(result.visibleTerrainPixels).toBeGreaterThan(2000);
  expect(result.outerFrameTerrainShare).toBeLessThan(0.08);
  expect(result.rightFrameContactRows).toBeLessThan(40);
  expect(result.bottomFrameContactColumns).toBeLessThan(150);
});
