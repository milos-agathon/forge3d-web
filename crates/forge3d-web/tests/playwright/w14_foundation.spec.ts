import {
  test,
  expect,
  skipRenderAssertionsWhenProbing,
} from "../browser/webgpu-fixture";
declare global {
  interface Window {
    __w14: any;
  }
}
test("W14 geographic vectors align with terrain in a real render", async ({page,webgpuAvailability}) => {
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  await page.goto("/examples/crs-datasets.html?dist");
  await page.waitForFunction(()=>!!window.__w14);
  const r=await page.evaluate(()=>window.__w14.alignment());
  expect(r.ids).toEqual([701,702,703]);
  expect(r.labelCount).toBe(3);
  expect(r.labelError).toBeLessThanOrEqual(.01);
  expect(r.pickPixels).toBeGreaterThan(100);
  expect(r.referencePixels).toBe(r.pickPixels);
  expect(r.pickEqual && r.rgbaEqual && r.inputIntact && r.terrainVisible).toBe(true);
  expect(r.negativePixels).toBe(0);
  expect(r.failure.code).toBe("INVALID_INPUT");
  expect(r.cancelled.code).toBe("REQUEST_CANCELLED");
  expect(r.failureAtomic && r.cancelAtomic).toBe(true);
});
test("W14 rejects a different factory on the worker module import", async ({page})=>{
  let reads=0;
  await page.route("**/assets/proj/proj-emscripten.js",async route=>{
    const response=await route.fetch();
    const text=await response.text();
    await route.fulfill({response,body:++reads === 1 ? text : text.replace("var Module=moduleArg;","throw new Error('tampered factory executed');var Module=moduleArg;")});
  });
  await page.goto("/examples/crs-datasets.html?dist");
  await page.waitForFunction(()=>!!window.__w14);
  const result=await page.evaluate(async()=>{
    try { const crs=await window.__w14.api.CrsTransformer.create({cache:null});crs.dispose();return null; }
    catch(e:any){return {code:e.code,details:e.details,message:e.message};}
  });
  expect(reads).toBe(2);
  expect(result).toMatchObject({code:"IO_ERROR",details:{kind:"asset-integrity",asset:"proj-emscripten.js"}});
  expect(result?.message).not.toContain("tampered factory executed");
});
for (const dist of [false, true]) {
  test(`W14 CRS controls, WKT and axis order (${dist ? "dist" : "source"})`, async ({
    page,
  }) => {
    page.on("response", (response) => {
      if (response.status() >= 400)
        console.error(response.status(), response.url());
    });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/examples/crs-datasets.html" + (dist ? "?dist" : ""));
    await page.waitForFunction(() => !!window.__w14);
    const r = await page.evaluate(() => window.__w14.coordinates());
    expect(r.projectedError).toBeLessThanOrEqual(0.01);
    expect(r.geographicError).toBeLessThanOrEqual(1e-7);
    expect(r.roundTripError).toBeLessThanOrEqual(0.02);
    expect(r.axisMatches).toBe(true);
    expect(r.metadata.epsg).toBe(32632);
    expect(r.wkt).toBe("EPSG:4326");
    expect(r.empty).toEqual([]);
    expect(r.largeCount).toBe(10000);
    expect(r.copyIsFloat64 && r.originalIntact).toBe(true);
    expect(r.errors.every((e: any) => e.code === "INVALID_INPUT")).toBe(true);
    expect(r.diagnostics.networkEnabled).toBe(false);
    expect(errors).toEqual([]);
  });
}
test("W14 all GeoJSON topology and automatic vector/label reprojection are transactional", async ({
  page,
}) => {
  await page.goto("/examples/crs-datasets.html?dist");
  await page.waitForFunction(() => !!window.__w14);
  const r = await page.evaluate(() => window.__w14.geometry());
  expect(r.inputIntact).toBe(true);
  expect(r.projected.features[0].id).toBe("p");
  expect(r.projected.features[1].geometry).toBeNull();
  expect(r.projected.features[2].geometry.geometries).toHaveLength(5);
  expect(r.back.features[0].geometry.coordinates[0]).toBeCloseTo(9, 7);
  expect(r.back.features[0].geometry.coordinates[1]).toBeCloseTo(40, 7);
  expect(r.back.features[0].geometry.coordinates[2]).toBe(120);
  expect(r.projected.bbox[0]).toBeGreaterThan(300000);
  expect(r.projected.crs.properties.name).toBe("EPSG:32632");
  expect(r.snapshot.features[0]).toMatchObject({
    id: 321,
    position: [500000, 120, expect.any(Number)],
  });
  expect(r.layerCount).toBe(1);
  expect(r.failure.code).toBe("INVALID_INPUT");
  expect(r.missingTarget.code).toBe("INVALID_INPUT");
  expect(r.labelMetadata).toMatchObject({
    crs: "EPSG:32632",
    source_crs: "EPSG:4326",
  });
  expect(r.labels).toHaveLength(4);
  for (const label of r.labels)
    expect(label.geometry.coordinates[0]).toBeCloseTo(500000, 2);
});
test("W14 grids never fall back to identity; missing best grid is structured", async ({
  page,
}) => {
  await page.goto("/examples/crs-datasets.html?dist");
  await page.waitForFunction(() => !!window.__w14);
  const r = await page.evaluate(() => window.__w14.grids());
  expect(r.shifted).toHaveLength(3);
  expect(r.gridError).toBeLessThanOrEqual(1e-7);
  expect(r.systemGridError).toBeLessThanOrEqual(1e-7);
  expect(r.missing.details.kind).toBe("crs-missing-grid");
  expect(r.bestMissing.details.kind).toBe("crs-missing-grid");
  expect(r.optional.code).toBe("INVALID_INPUT");
  expect(r.invalid).toBeNull();
});
test("W14 persistent data/PROJ/grid cache survives new workers and asset network denial", async ({
  page,
}) => {
  await page.goto("/examples/crs-datasets.html?dist");
  await page.waitForFunction(() => !!window.__w14);
  await page.evaluate(() => window.__w14.coordinates());
  const data = await page.evaluate(() => window.__w14.datasets());
  expect(data.width).toBe(256);
  expect(data.min).toBeLessThan(0);
  expect(data.max).toBeGreaterThan(500);
  expect(data.boundaries).toBeGreaterThanOrEqual(3);
  await page.route(
    /\/assets\/(?:datasets|proj)\/.*\.(?:npy|geojson|wasm|db|tif)$/,
    (route) => route.abort(),
  );
  const r = await page.evaluate(() => window.__w14.offline());
  expect(r.point[0][0]).toBeCloseTo(500000, 2);
  expect(r.datasets.digest).toBe(data.digest);
  expect(r.grid[0][0]).toBeCloseTo(-100.00040583667015, 8);
});
test("W14 worker cancellation, admission limits and disposal release owned resources", async ({
  page,
}) => {
  await page.goto("/examples/crs-datasets.html?dist");
  await page.waitForFunction(() => !!window.__w14);
  const r = await page.evaluate(() => window.__w14.lifetime());
  expect(r.cancellation.code).toBe("REQUEST_CANCELLED");
  expect(r.budget.code).toBe("RESOURCE_LIMIT_EXCEEDED");
  expect(r.disposal.code).toBe("RUNTIME_DISPOSED");
  expect(r.after.code).toBe("RUNTIME_DISPOSED");
  expect(r.tiny.code).toBe("RESOURCE_LIMIT_EXCEEDED");
  expect(r.diagnostics).toMatchObject({
    workerCount: 0,
    pendingCalls: 0,
    assetBytes: 0,
    wasmHeapBytes: 0,
    reservedBytes: 0,
    gpuBytes: 0,
    disposed: true,
  });
});
test("W14 CPU geospatial foundation survives a GPU device loss", async ({
  page,
  webgpuAvailability,
}) => {
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  await page.goto("/examples/crs-datasets.html?dist");
  await page.waitForFunction(() => !!window.__w14);
  const r = await page.evaluate(() => window.__w14.lostDevice());
  expect(r.point[0][0]).toBeCloseTo(500000, 2);
  expect(r.gpuBytes).toBe(0);
  expect(r.lossReason).toBe("destroyed");
});
test("W14 validates persistent cache contents, grid digests, setup cancellation and backend absence", async ({
  page,
}) => {
  await page.goto("/examples/crs-datasets.html?dist");
  await page.waitForFunction(() => !!window.__w14);
  await page.route("**/w14-bad-grid.tif", (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/tiff",
      body: Buffer.alloc(173029),
    }),
  );
  const result = await page.evaluate(async () => {
    const { CrsTransformer, DatasetRegistry, IndexedDbByteCache } =
      window.__w14.api;
    const cache = new IndexedDbByteCache({ name: "w14-negative-control" }),
      registry = new DatasetRegistry({ cache }),
      metadata = registry.info("mini_dem");
    const key =
      "forge3d:asset:native-1f4084af428dc699bdcd108b029736cb73903926:" +
      metadata.sha256;
    const attempt = async (f: any) => {
      try {
        await f();
        return null;
      } catch (error: any) {
        return { code: error.code, details: error.details };
      }
    };
    await cache.put(key, new Uint8Array([1, 2, 3]));
    const corruption = await attempt(() =>
        registry.fetch("mini_dem", { offline: true }),
      ),
      deleted = (await cache.get(key)) === undefined;
    const grid = await attempt(() =>
      CrsTransformer.create({
        cache: null,
        grids: [
          {
            name: "bad.tif",
            url: "/w14-bad-grid.tif",
            sha256: "0".repeat(64),
            byteLength: 173029,
            version: "negative-v1",
          },
        ],
      }),
    );
    const controller = new AbortController();
    const abort = await attempt(() =>
      CrsTransformer.create({
        cache: null,
        signal: controller.signal,
        onProgress: (p: any) => {
          if (p.loaded > 0) controller.abort();
        },
      }),
    );
    const WorkerOriginal = window.Worker;
    let backend;
    try {
      Object.defineProperty(window, "Worker", {
        value: undefined,
        configurable: true,
        writable: true,
      });
      backend = await attempt(() => CrsTransformer.create({ cache: null }));
    } finally {
      window.Worker = WorkerOriginal;
    }
    registry.dispose();
    return { corruption, deleted, grid, abort, backend };
  });
  expect(result.corruption).toMatchObject({
    code: "IO_ERROR",
    details: { kind: "asset-integrity" },
  });
  expect(result.deleted).toBe(true);
  expect(result.grid).toMatchObject({
    code: "IO_ERROR",
    details: { kind: "asset-integrity" },
  });
  expect(result.abort.code).toBe("REQUEST_CANCELLED");
  expect(result.backend).toMatchObject({
    code: "UNSUPPORTED_FEATURE",
    details: { kind: "crs-backend-unavailable" },
  });
});
