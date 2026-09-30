import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, skipRenderAssertionsWhenProbing, test } from "../browser/webgpu-fixture";

declare global {
  interface Window {
    __forge3dW08Cog: Record<string, (...args: any[]) => Promise<any>>;
  }
}

const here = fileURLToPath(new URL(".", import.meta.url));
const fixtureDir = join(here, "..", "golden", "w08");

function fixtureBytes(name: string): Buffer {
  return readFileSync(join(fixtureDir, name));
}

function fixtureTruth(name: string): any {
  return JSON.parse(
    readFileSync(join(fixtureDir, name.replace(/\.tif$/, ".json")), "utf8"),
  );
}

const cogUrl = (name: string, mode = "range") =>
  `/w08-cog/${name}?mode=${mode}`;

interface RangeStats {
  requests: number;
  bytesDelivered: number;
  aborted: number;
  seen: import("@playwright/test").Request[];
}

// `request.failure()` reports net::ERR_ABORTED for requests the page
// aborted mid-flight; `requestfailed` events are unreliable for
// route-fulfilled responses, so assert through the captured requests.
async function abortedRequestCount(stats: RangeStats): Promise<number> {
  let count = 0;
  for (const request of stats.seen) {
    const failure = await request.failure();
    if (failure !== null) count += 1;
  }
  return count;
}

async function installRangeServer(
  page: import("../browser/webgpu-fixture").Page,
): Promise<RangeStats> {
  const stats: RangeStats = {
    requests: 0,
    bytesDelivered: 0,
    aborted: 0,
    seen: [],
  };
  page.on("requestfailed", (request) => {
    if (request.url().includes("/w08-cog/")) {
      stats.aborted += 1;
    }
  });
  await page.route("**/w08-cog/**", async (route) => {
    stats.requests += 1;
    stats.seen.push(route.request());
    const url = new URL(route.request().url());
    const name = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    const mode = url.searchParams.get("mode") ?? "range";
    let bytes: Buffer;
    try {
      bytes = fixtureBytes(name);
    } catch {
      await route.fulfill({ status: 404, body: "unknown fixture" });
      return;
    }
    const delay = Number(url.searchParams.get("delay") ?? "0");
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    const request = route.request();
    const rangeHeader = request.headers()["range"];
    if (mode === "full" || rangeHeader === undefined) {
      // Range-ignoring server: streams the WHOLE file with a 200.
      await route.fulfill({
        status: 200,
        headers: {
          "content-length": String(bytes.length),
          "content-type": "image/tiff",
          etag: '"w08-cog-v1"',
        },
        body: bytes,
      });
      return;
    }
    const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
    if (match === null) {
      await route.fulfill({ status: 400, body: "bad range" });
      return;
    }
    const start = Number(match[1]);
    const end = match[2] !== "" ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;
    if (start >= bytes.length || end < start) {
      await route.fulfill({ status: 416, body: "unsatisfiable" });
      return;
    }
    const slice = bytes.subarray(start, end + 1);
    stats.bytesDelivered += slice.length;
    await route.fulfill({
      status: 206,
      headers: {
        "content-range": `bytes ${start}-${end}/${bytes.length}`,
        "content-length": String(slice.length),
        "accept-ranges": "bytes",
        etag: '"w08-cog-v1"',
        "content-type": "image/tiff",
      },
      body: slice,
    });
  });
  return stats;
}

async function installOfflineServer(
  page: import("../browser/webgpu-fixture").Page,
): Promise<RangeStats> {
  const stats: RangeStats = {
    requests: 0,
    bytesDelivered: 0,
    aborted: 0,
    seen: [],
  };
  page.on("requestfailed", (request) => {
    if (request.url().includes("/w08-cog/")) {
      stats.aborted += 1;
    }
  });
  await page.route("**/w08-cog/**", async (route) => {
    stats.requests += 1;
    stats.seen.push(route.request());
    await route.abort();
  });
  return stats;
}

async function probe(
  page: import("../browser/webgpu-fixture").Page,
  name: string,
  ...args: any[]
): Promise<any> {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  if (!page.url().includes("test-w08-cog.html")) {
    await page.goto("/examples/test-w08-cog.html");
  }
  await page.waitForFunction(() => window.__forge3dW08Cog !== undefined);
  const result = await page.evaluate(
    ([key, params]) => window.__forge3dW08Cog[key as string]!(...params),
    [name, args] as const,
  );
  expect(errors, `page errors in ${name}`).toEqual([]);
  if (process.env.FORGE3D_W08_DEBUG) {
    console.log(name, JSON.stringify(result, null, 1).slice(0, 20000));
  }
  return result;
}

test.describe("W08 COG: range scheduler + geotiff over a mocked range server", () => {
  test.beforeEach(({ webgpuAvailability }) => {
    skipRenderAssertionsWhenProbing(webgpuAvailability);
  });

  test("metadata/ifdInfo/overviews match the rasterio truth JSON", async ({ page }) => {
    const truth = fixtureTruth("rainier-cog.tif");
    const stats = await installRangeServer(page);
    const r = await probe(page, "metadata", cogUrl("rainier-cog.tif"));
    expect(r.metadata.width).toBe(truth.width);
    expect(r.metadata.height).toBe(truth.height);
    expect(r.metadata.overviewCount).toBe(truth.levels.length);
    expect(r.metadata.nodata).toBe(truth.nodata);
    expect(r.metadata.crs).toBe("EPSG:4326");
    truth.bounds.forEach((value: number, index: number) => {
      expect(r.metadata.bounds[index]).toBeCloseTo(value, 9);
    });
    // Truth stores the rasterio Affine order (a,b,c,d,e,f); the web API
    // returns GDAL order (x0,rx,sx,y0,sy,ry) = (c,a,b,f,d,e).
    const t = truth.transform;
    const gdal = [t[2], t[0], t[1], t[5], t[3], t[4]];
    gdal.forEach((value: number, index: number) => {
      expect(r.metadata.geoTransform[index]).toBeCloseTo(value, 12);
    });
    expect(r.metadata.bands).toBe(truth.count);
    truth.levels.forEach((level: any, index: number) => {
      const info = r.metadata.ifdInfo[index];
      expect(info.width).toBe(level.width);
      expect(info.height).toBe(level.height);
      expect(info.tileWidth).toBe(level.tileWidth);
      expect(info.tileHeight).toBe(level.tileHeight);
      expect(info.tilesAcross).toBe(level.tilesAcross);
      expect(info.tilesDown).toBe(level.tilesDown);
      expect(info.tileCount).toBe(level.tileCount);
      expect(info.compression).toBeGreaterThan(0);
    });
    expect(stats.requests).toBeGreaterThan(0);
  });

  for (const mode of ["worker", "main"] as const) {
    test(`predictor-deflate-u16 tile decodes exactly via ${mode}`, async ({ page }) => {
      const truth = fixtureTruth("predictor-deflate-u16.tif");
      await installRangeServer(page);
      const r = await probe(
        page,
        "predictor",
        cogUrl("predictor-deflate-u16.tif"),
        mode,
      );
      if (mode === "worker") {
        expect(r.poolMode, "real module worker expected").not.toBe("main-thread");
      } else {
        expect(r.poolMode).toBe("main-thread");
      }
      expect(r.width).toBe(16);
      expect(r.height).toBe(16);
      // Exact values: (arange(256) * 3) + 7.
      expect(r.sha256).toBe(truth.tileSha256[0]);
      expect(r.samples.first).toBe(7);
      expect(r.samples.last).toBe(772);
    });
  }

  for (const mode of ["worker", "main"] as const) {
    test(`rainier tile (0,0) digests match truth at every level via ${mode}`, async ({ page }) => {
      test.slow();
      const truth = fixtureTruth("rainier-cog.tif");
      await installRangeServer(page);
      const r = await probe(page, "rainierTiles", cogUrl("rainier-cog.tif"), mode);
      if (mode === "worker") {
        expect(r.poolMode).not.toBe("main-thread");
      }
      truth.tileSha256.forEach((digest: string, level: number) => {
        expect(r.levels[level].sha256, `level ${level} tile digest`).toBe(digest);
      });
      // Coarsest level is a single tile = the whole image: fixed-pixel samples.
      const coarsest = r.levels.at(-1);
      const truthSamples = truth.samples.at(-1);
      expect(coarsest.samples.first).toBeCloseTo(truthSamples["0,0"], 4);
      expect(coarsest.samples.center).toBeCloseTo(truthSamples.center, 4);
      expect(coarsest.samples.last).toBeCloseTo(truthSamples.last, 4);
      expect(r.metadata.overviewCount).toBe(3);
    });
  }

  test("single-tile read transfers a small fraction of the file", async ({ page }) => {
    const truth = fixtureTruth("rainier-cog.tif");
    const stats = await installRangeServer(page);
    const r = await probe(page, "singleTileBytes", cogUrl("rainier-cog.tif"));
    expect(r.fileBytes).toBe(truth.sizeBytes);
    expect(stats.bytesDelivered).toBeLessThan(truth.sizeBytes * 0.25);
    expect(r.bytesTransferred).toBeLessThan(truth.sizeBytes * 0.25);
  });

  test("repeat tile read hits the decoded-tile cache with no new requests", async ({ page }) => {
    await installRangeServer(page);
    const r = await probe(page, "repeatRead", cogUrl("rainier-cog.tif"));
    expect(r.newRequests, "second read must not hit the network").toBe(0);
    expect(r.newBytes).toBe(0);
    expect(r.cacheHits).toBeGreaterThanOrEqual(1);
  });

  for (const kind of ["opfs", "indexeddb", "cache-storage"] as const) {
    test(`persistent cache (${kind}): offline replay + checksum corruption recovery`, async ({
      page,
    }) => {
      test.slow();
      const truth = fixtureTruth("rainier-cog.tif");
      const url = cogUrl("rainier-cog.tif");
      const online = await installRangeServer(page);
      const available = await probe(page, "backendsAvailable");
      test.skip(
        !available[kind === "cache-storage" ? "cacheStorage" : kind],
        `${kind} backend unavailable in this context`,
      );
      const prime = await probe(page, "primePersistent", url, kind);
      expect(prime.digests[0]).toBe(truth.tileSha256[0]);
      expect(
        prime.persistent?.bytes ?? 0,
        "no persistent entries were written",
      ).toBeGreaterThan(0);
      const onlineRequests = online.requests;
      expect(onlineRequests).toBeGreaterThan(0);

      // Reload: all COG network is aborted; reads must come from the
      // persistent cache alone.
      const offline = await installOfflineServer(page);
      await page.reload();
      const replay = await probe(page, "replayPersistent", url, kind);
      expect(replay.digests).toEqual(prime.digests);
      expect(
        replay.persistent?.hits ?? 0,
        JSON.stringify(replay.persistent),
      ).toBeGreaterThan(0);
      expect(replay.range.offlineServed + (replay.persistent?.hits ?? 0)).toBeGreaterThan(0);

      // Corrupt one real-backend entry: the next read must count a
      // checksum failure, then refetch cleanly once the network returns.
      const corrupted = await probe(page, "corruptEntry", kind);
      expect(corrupted.corrupted).toBe(true);
      await installRangeServer(page);
      const recovered = await probe(page, "replayPersistent", url, kind);
      expect(
        recovered.persistent?.checksumFailures ?? 0,
        JSON.stringify(recovered.persistent),
      ).toBeGreaterThanOrEqual(1);
      expect(recovered.digests).toEqual(prime.digests);

      await probe(page, "clearPersistent", kind);
      void offline;
    });
  }

  test("range-ignoring server produces a typed error without a full download", async ({
    page,
  }) => {
    const truth = fixtureTruth("rainier-cog.tif");
    const stats = await installRangeServer(page);
    const r = await probe(page, "rangeIgnored", cogUrl("rainier-cog.tif", "full"));
    expect(r.code).toBe("IO_ERROR");
    expect(r.reason, JSON.stringify(r)).toBe("range-not-supported");
    // The H3 fix: the fetch is aborted and the response body cancelled, so
    // (a) the page consumed a bounded prefix only, and (b) the aborted
    // request surfaces at the network layer.
    expect(r.range.bytesTransferred).toBeLessThan(truth.sizeBytes);
    // The aborted fetch surfaces as a failed request at the network layer.
    await expect
      .poll(() => abortedRequestCount(stats), {
        message: "fetch must be aborted on a range-ignored 200",
      })
      .toBeGreaterThan(0);
  });

  test("AbortSignal mid-flight rejects REQUEST_CANCELLED and aborts the fetch", async ({
    page,
  }) => {
    const stats = await installRangeServer(page);
    // The route delays its response so the abort lands mid-flight.
    const r = await probe(
      page,
      "abortRead",
      cogUrl("rainier-cog.tif") + "&delay=200",
    );
    expect(r.code, JSON.stringify(r)).toBe("REQUEST_CANCELLED");
    expect(r.signalAborted).toBe(true);
    // The aborted fetch surfaces as a failed request at the network layer.
    await expect
      .poll(() => abortedRequestCount(stats), {
        message: "aborted request must fail at the network layer",
      })
      .toBeGreaterThan(0);
  });

  test("disposing the dataset aborts in-flight range requests", async ({ page }) => {
    const stats = await installRangeServer(page);
    const r = await probe(page, "disposeAbort", cogUrl("rainier-cog.tif"));
    expect(r.results.length).toBe(2);
    for (const code of r.results) {
      expect(["REQUEST_CANCELLED", "RUNTIME_DISPOSED"]).toContain(code);
    }
    void stats;
  });
});

test.describe("W08 COG: streaming, overlay, recovery, memory", () => {
  test.beforeEach(({ webgpuAvailability }) => {
    skipRenderAssertionsWhenProbing(webgpuAvailability);
  });

  test("TerrainStreamer + CogHeightSource converges on clipmap without full download", async ({
    page,
  }) => {
    test.slow();
    test.setTimeout(300_000);
    const truth = fixtureTruth("rainier-cog.tif");
    await installRangeServer(page);
    const r = await probe(page, "streamRainier", cogUrl("rainier-cog.tif"));
    expect(r.converged, JSON.stringify(r.runtime)).toBe(true);
    expect(r.convergedClearPixels, "converged frame clear pixels").toBe(0);
    expect(r.coarseVsConvergedMaxDiff, "fine == coarse?").toBeGreaterThan(0);
    expect(r.bytesTransferred).toBeLessThan(truth.sizeBytes);
    expect(r.runtime.residentHeightBytes).toBeLessThanOrEqual(r.runtime.maxResidentBytes);
    expect(r.uploadedTiles).toBeGreaterThan(0);
  });

  test("landcover COG overview drapes the streamed terrain deterministically", async ({ page }) => {
    test.slow();
    test.setTimeout(300_000);
    await installRangeServer(page);
    const r = await probe(
      page,
      "landcoverOverlay",
      cogUrl("rainier-cog.tif"),
      cogUrl("landcover-rgba-cog.tif"),
    );
    expect(r.converged).toBe(true);
    expect(r.overlayReport.enabled).toBe(true);
    expect(r.overlayReport.layerCount).toBe(1);
    expect(r.terrainCrs).toBe(r.overlayCrs);
    expect(r.deterministic, "overlay render must be byte-stable").toBe(true);
  });

  test("viewer device-loss recovery replays streaming with zero new network bytes", async ({
    page,
  }) => {
    test.slow();
    test.setTimeout(300_000);
    const stats = await installRangeServer(page);
    const r = await probe(page, "viewerRecovery", cogUrl("rainier-cog.tif"));
    expect(r.status).toBe("ready");
    expect(r.generationAfter).toBeGreaterThan(r.generationBefore);
    expect(r.replayBytes, "recovery must not refetch").toBe(0);
    expect(r.identical || r.ssim >= 0.999, `identical=${r.identical} ssim=${r.ssim}`).toBe(true);
    void stats;
  });

  test("30 commit/render/release cycles return the memory ledger to baseline", async ({
    page,
  }) => {
    test.slow();
    test.setTimeout(300_000);
    await installRangeServer(page);
    const r = await probe(page, "memoryCycles");
    expect(r.cycles).toBe(30);
    expect(r.allReturned, JSON.stringify(r.deltas)).toBe(true);
    expect(r.maxDelta).toBe(0);
    expect(r.peakLoadedBytes).toBeGreaterThan(r.baselineBytes);
  });
});
