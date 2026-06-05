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
    __forge3dTerrainSourceFailureProbe: (urls: {
      fetchFailureUrl: string;
      rangeFailureUrl: string;
      bodyFailureUrl: string;
    }) => Promise<{
      supported: boolean;
      fetchFailureCode?: string;
      rangeFailureCode?: string;
      bodyFailureCode?: string;
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

test("maps browser terrain source failures to documented error codes", async ({
  page
}) => {
  await page.route("**/missing-terrain.bin", async (route) => {
    await route.fulfill({
      status: 404,
      contentType: "application/octet-stream",
      body: "not found"
    });
  });
  await page.route("**/range-failure-terrain.bin", async (route) => {
    await route.fulfill({
      status: 416,
      contentType: "application/octet-stream",
      body: "requested range not satisfiable"
    });
  });
  await page.route("**/body-failure-terrain.bin", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/octet-stream",
      body: "\0\0\0\0"
    });
  });

  await page.goto("/examples/test-terrain-sources.html");

  const result = await page.evaluate(() =>
    window.__forge3dTerrainSourceFailureProbe({
      fetchFailureUrl: "/missing-terrain.bin",
      rangeFailureUrl: "/range-failure-terrain.bin",
      bodyFailureUrl: "/body-failure-terrain.bin"
    })
  );

  expect(result.supported).toBeTruthy();
  expect(result.fetchFailureCode).toBe("IO_ERROR");
  expect(result.rangeFailureCode).toBe("IO_ERROR");
  expect(result.bodyFailureCode).toBe("IO_ERROR");
});
