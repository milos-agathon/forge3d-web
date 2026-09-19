import { expect, test } from "../browser/webgpu-fixture";

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

test("public viewer enforces exact zero and nonzero HTTP range policy", async ({
  page,
}) => {
  const terrain = Buffer.alloc(16);
  [0, 1, 2, 3].forEach((value, index) => terrain.writeFloatLE(value, index * 4));
  const ranged = Buffer.concat([Buffer.alloc(4), terrain]);
  await page.route("**/saf02-range-206.bin", async (route) => {
    expect(route.request().headers().range).toBe("bytes=4-19");
    await route.fulfill({ status: 206, body: terrain, headers: { "Content-Type": "application/octet-stream", "Content-Range": "bytes 4-19/20", "Content-Length": "16" } });
  });
  await page.route("**/saf02-zero-200.bin", (route) => route.fulfill({ status: 200, body: terrain, contentType: "application/octet-stream" }));
  await page.route("**/saf02-nonzero-200.bin", (route) => route.fulfill({ status: 200, body: ranged, contentType: "application/octet-stream" }));
  await page.route("**/saf02-range-416.bin", (route) => route.fulfill({ status: 416, body: "", headers: { "Content-Range": "bytes */20" } }));
  await page.goto("/examples/test-clear.html");
  const outcomes = await page.evaluate(async () => {
    const { Forge3DViewer, Forge3DError } = await import("/src-ts/index.ts");
    const cases = [
      ["/saf02-range-206.bin", { byteOffset: 4, byteLength: 16 }],
      ["/saf02-zero-200.bin", { byteOffset: 0, byteLength: 16 }],
      ["/saf02-nonzero-200.bin", { byteOffset: 4, byteLength: 16 }],
      ["/saf02-range-416.bin", { byteOffset: 4, byteLength: 16 }],
    ] as const;
    const results: string[] = [];
    for (const [source, range] of cases) {
      const canvas = document.createElement("canvas");
      const viewer = await Forge3DViewer.create(canvas, { resize: false });
      try {
        await viewer.setTerrainFromSource({ width: 2, height: 2, source, ...range });
        results.push("PASS");
      } catch (error) {
        results.push(Forge3DError.from(error).code);
      } finally {
        viewer.dispose();
      }
    }
    return results;
  });
  expect(outcomes).toEqual(["PASS", "PASS", "IO_ERROR", "IO_ERROR"]);
});
