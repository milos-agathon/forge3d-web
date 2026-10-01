import {
  expect,
  skipRenderAssertionsWhenProbing,
  test,
} from "../browser/webgpu-fixture";

declare global {
  interface Window {
    __forge3dW08PackageProbe: (fixtureUrl: string) => Promise<any>;
  }
}

const PREDICTOR_TILE_SHA =
  "18e1b10ecc37597db28376dd9a533ccb6a03c075d7a3b4e448be562abff740fb";

test("W08 public-API consumer: vendored COG decode, clipmap, overlay, VT stats", async ({
  page,
  webgpuAvailability,
}) => {
  skipRenderAssertionsWhenProbing(webgpuAvailability);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/examples/test-w08-package.html");
  await page.waitForFunction(
    () => window.__forge3dW08PackageProbe !== undefined,
  );
  const result = await page.evaluate(() =>
    window.__forge3dW08PackageProbe(
      "/tests/golden/w08/predictor-deflate-u16.tif",
    ),
  );

  expect(result.supported).toBe(true);
  expect(result.error).toBeUndefined();
  expect(result.ok, JSON.stringify(result.error)).toBe(true);

  // Vendored geotiff decodes the predictor fixture exactly on both paths.
  expect(result.mainThread.width).toBe(16);
  expect(result.mainThread.sha256).toBe(PREDICTOR_TILE_SHA);
  expect(result.mainThread.first).toBe(7);
  expect(result.mainThread.last).toBe(772);
  expect(result.worker.mode).not.toBe("main-thread");
  expect(result.decodeParity).toBe(true);

  // Clipmap + overlay + VT stats through the consumer surface.
  expect(result.render.nonClearPixels).toBeGreaterThan(0);
  expect(result.render.geometry.mode).toBe("clipmap");
  expect(result.render.geometry.triangleCount).toBe(
    result.render.geometry.triangleBudget,
  );
  expect(result.render.overlays.enabled).toBe(true);
  expect(result.render.overlays.layerCount).toBe(1);
  expect(result.render.vt).not.toBeNull();
  expect(pageErrors).toEqual([]);

  // The built dist vendors geotiff: cog.js must lazily import the vendored
  // wrapper and leave no bare `geotiff` specifier for no-bundler consumers.
  // The dev server may rewrite the relative specifier to an absolute
  // `/dist/vendor/...` path, so both forms are accepted.
  const distCog = await page.request.get("/dist/cog.js");
  expect(distCog.ok()).toBe(true);
  const distCogText = await distCog.text();
  expect(distCogText).toMatch(
    /import\s*\(\s*["'](?:\.\/|\/dist\/)vendor\/geotiff\.js["']\s*\)/,
  );
  expect(distCogText).not.toMatch(/import\s*\(\s*["']geotiff["']\s*\)/);
  expect(distCogText).not.toMatch(/from\s+["']geotiff["']/);
  const vendorWrapper = await page.request.get("/dist/vendor/geotiff.js");
  expect(vendorWrapper.ok()).toBe(true);
  const vendorUmd = await page.request.get("/dist/vendor/geotiff.umd.js");
  expect(vendorUmd.ok()).toBe(true);

  // Serving the files is not enough: the page above decodes through
  // src-ts (geotiff resolved by the dev server), so evaluate the built dist
  // path itself — dist/index.js -> cog.js -> vendor/geotiff.js — and decode
  // the same tile through it.
  const dist = await page.evaluate(async (fixtureUrl) => {
    const wrapper = await import("/dist/vendor/geotiff.js");
    const { CogDataset } = await import("/dist/index.js");
    const dataset = await CogDataset.open(fixtureUrl);
    const tile = await dataset.readTile(0, 0, 0);
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new Uint8Array(tile.buffer, tile.byteOffset, tile.byteLength),
    );
    return {
      wrapperExports: ["fromUrl", "GeoTIFF", "getDecoder"].map(
        (name) => typeof wrapper[name],
      ),
      sha256: Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join(""),
    };
  }, "/tests/golden/w08/predictor-deflate-u16.tif");
  expect(dist.wrapperExports).toEqual(["function", "function", "function"]);
  expect(dist.sha256).toBe(result.mainThread.sha256);
});
