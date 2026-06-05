import { expect, test } from "@playwright/test";

declare global {
  interface Window {
    __forge3dTerrainSourcesProbe: () => Promise<{
      supported: boolean;
      width: number;
      height: number;
      variedPixels: number;
      lumaRange: number;
      sourceNames: string[];
      progressDoneCount: number;
      cancelCode?: string;
    }>;
  }
}

test("loads terrain heightmap bytes from browser source adapters", async ({
  page
}) => {
  await page.goto("/examples/test-terrain-sources.html");

  const result = await page.evaluate(() =>
    window.__forge3dTerrainSourcesProbe()
  );

  expect(result.supported).toBeTruthy();
  expect(result.width).toBe(128);
  expect(result.height).toBe(96);
  expect(result.sourceNames).toEqual([
    "ArrayBuffer",
    "Blob",
    "File",
    "Url"
  ]);
  expect(result.progressDoneCount).toBe(4);
  expect(result.cancelCode).toBe("REQUEST_CANCELLED");
  expect(result.variedPixels).toBeGreaterThan(1000);
  expect(result.lumaRange).toBeGreaterThan(30);
});
