import { expect, test } from "@playwright/test";

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
