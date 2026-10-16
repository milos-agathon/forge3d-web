import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  statSync,
  rmSync,
  copyFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import {
  dirname,
  join,
  resolve,
  relative,
  isAbsolute,
  extname,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { resolveCommandInvocation } from "./command-executable.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(join(tmpdir(), "forge3d-w14-consumer-")),
  consumer = join(temp, "consumer"),
  pack = join(temp, "pack");
let browser, server;
const projScriptRequests = [];
let hostileModuleExecutions = 0;
function run(command, args, cwd = root) {
  const invocation = resolveCommandInvocation(command, args);
  const r = spawnSync(invocation.command, invocation.args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (r.error || r.status !== 0)
    throw Error(r.error?.message ?? r.stdout + r.stderr);
  return r.stdout;
}
try {
  run("npm", ["run", "build:ts"]);
  run("npm", ["run", "prepare-dist"]);
  run("npm", ["run", "test:api"]);
  mkdirSync(consumer);
  mkdirSync(pack);
  const metadata = JSON.parse(
    run("npm", ["pack", "--json", "--pack-destination", pack]),
  )[0];
  const tarball = join(pack, metadata.filename),
    sha256 = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
    consumer,
  );
  const installed = join(consumer, "node_modules/@forge3d/web");
  assert(!statSync(join(installed, "dist/crs-worker.js")).isDirectory());
  for (const path of [
    "assets/proj/proj.db",
    "assets/proj/proj-emscripten.wasm",
    "assets/proj/LICENSE",
    "assets/proj/PROJ-COPYING",
    "assets/proj/GRID-LICENSE.txt",
    "assets/datasets/mini_dem.npy",
    "assets/datasets/sample_boundaries.geojson",
    "docs/crs-datasets.md",
    "types/crs.d.ts",
    "types/datasets.d.ts",
  ])
    assert(statSync(join(installed, path)).size > 0, path);
  const assetManifest = JSON.parse(
    readFileSync(join(installed, "dist/asset-manifest.json")),
  );
  for (const a of assetManifest.assets)
    assert.equal(
      createHash("sha256")
        .update(readFileSync(join(installed, a.path)))
        .digest("hex"),
      a.sha256,
      a.path,
    );
  writeFileSync(
    join(consumer, "index.html"),
    readFileSync(join(root, "examples/crs-datasets.html"), "utf8").replace(
      "./w14-foundation.js",
      "/acceptance.mjs",
    ),
  );
  writeFileSync(
    join(consumer, "acceptance.mjs"),
    readFileSync(join(root, "examples/w14-foundation.js"), "utf8")
      .replaceAll(
        "../src-ts/index.ts",
        "/node_modules/@forge3d/web/dist/index.js",
      )
      .replaceAll(
        "../dist/index.js",
        "/node_modules/@forge3d/web/dist/index.js",
      )
      .replace("../tests/fixtures/w14/crs-epsg-v1.json", "/crs-epsg-v1.json"),
  );
  copyFileSync(
    join(root, "tests/fixtures/w14/crs-epsg-v1.json"),
    join(consumer, "crs-epsg-v1.json"),
  );
  writeFileSync(
    join(consumer, "consumer.ts"),
    `import {CrsTransformer,DatasetRegistry,VectorLayers,TerrainDataset,type Forge3DRuntime,crsToEpsg,crsFromRasterMetadata,reprojectLabelFeatures,type CrsMetadata,type DatasetMetadata} from '@forge3d/web';
async function use(runtime:Forge3DRuntime){const crs=await CrsTransformer.create();const m:CrsMetadata=await crs.parseCrs('EPSG:32632');const a:Float64Array=await crs.transformCoords(new Float32Array([9,40]),'EPSG:4326','EPSG:32632');const nested:number[][]=await crs.transformCoords([[9,40]],'EPSG:4326','EPSG:32632');const registry=new DatasetRegistry();const d:DatasetMetadata=registry.info('mini_dem');const dem=await registry.miniDem({offline:true});const vectors=new VectorLayers();await vectors.addGeospatial({name:'point',crs:'EPSG:4326',features:[{id:1,kind:'point',position:[9,0,40]}]},'EPSG:32632',crs);const terrain=TerrainDataset.fromArray({width:2,height:2,heights:new Float32Array(4),crs:'EPSG:32632',transform:[499990,10,0,4427770,0,-10],spacing:[10,10]});runtime.setTerrain(terrain);await runtime.setVectorLayers(vectors);void [m,a,nested,d,dem,crsToEpsg('epsg:4326'),crsFromRasterMetadata({epsg:32632}),reprojectLabelFeatures];crs.dispose();registry.dispose();vectors.dispose();}void use;`,
  );
  run(
    process.execPath,
    [
      join(root, "node_modules/typescript/bin/tsc"),
      "consumer.ts",
      "--module",
      "es2022",
      "--moduleResolution",
      "bundler",
      "--target",
      "es2022",
      "--lib",
      "es2022,dom,dom.iterable",
      "--strict",
      "--noEmit",
    ],
    consumer,
  );
  const csp =
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:";
  server = createServer((req, res) => {
    try {
      const pathname = decodeURIComponent(
        new URL(req.url, "http://localhost").pathname,
      );
      if (pathname === '/w14-module-executed') {
        hostileModuleExecutions++;
        res.end('executed');
        return;
      }
      let path = resolve(consumer, "." + pathname);
      const rel = relative(consumer, path);
      if (rel.startsWith("..") || isAbsolute(rel))
        throw Error("outside consumer");
      if (statSync(path).isDirectory()) path = join(path, "index.html");
      let data = readFileSync(path);
      // Byte fetches get the pinned reference. Any executable import gets a
      // hostile top-level response, reproducing the former second-fetch flaw.
      if (pathname.endsWith('/assets/proj/proj-emscripten.js') && req.headers['sec-fetch-dest'] === 'script') {
        projScriptRequests.push(pathname);
        data = Buffer.concat([Buffer.from("fetch('/w14-module-executed');throw Error('hostile module executed');\n"), data]);
      }
      const mime =
          {
            ".html": "text/html",
            ".js": "text/javascript",
            ".mjs": "text/javascript",
            ".json": "application/json",
            ".wasm": "application/wasm",
            ".geojson": "application/geo+json",
          }[extname(path)] ?? "application/octet-stream";
      // Immutable module URLs also allow a fresh worker when the network is offline.
      res.writeHead(200, {
        "content-type": mime,
        "content-length": data.length,
        "content-security-policy": csp,
        "cache-control": "public, max-age=31536000, immutable",
      });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end("Missing");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      ...(process.platform === "win32" ? ["--use-angle=d3d11"] : []),
    ],
  });
  const context = await browser.newContext(),
    page = await context.newPage(),
    errors = [],
    remote = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (!r.url().startsWith(origin)) remote.push(r.url());
  });
  await page.goto(origin);
  await page.waitForFunction(() => !!window.__w14);
  const results = {};
  for (const name of [
    "coordinates",
    "geometry",
    "alignment",
    "grids",
    "datasets",
    "lifetime",
    "lostDevice",
  ]) {
    results[name] = await page.evaluate((name) => window.__w14[name](), name);
    console.log("Installed W14 " + name + ": executed");
  }
  const c = results.coordinates;
  assert(
    c.projectedError <= 0.01 &&
      c.geographicError <= 1e-7 &&
      c.roundTripError <= 0.02 &&
      c.axisMatches &&
      c.originalIntact &&
      c.copyIsFloat64,
  );
  assert(c.errors.every((e) => e.code === "INVALID_INPUT"));
  const g = results.geometry;
  assert(g.inputIntact && g.layerCount === 1 && g.labels.length === 4);
  assert.equal(g.snapshot.features[0].id, 321);
  assert.equal(g.snapshot.features[0].position[1], 120);
  assert.equal(g.failure.code, "INVALID_INPUT");
  for (const label of g.labels)
    assert(Math.abs(label.geometry.coordinates[0] - 500000) <= 0.01);
  const grids = results.grids;
  assert(grids.shifted.length === 3 && grids.gridError <= 1e-7 && grids.systemGridError <= 1e-7);
  const alignment=results.alignment;
  assert.deepEqual(alignment.ids,[701,702,703]);
  assert(alignment.labelCount === 3 && alignment.labelError <= .01);
  assert(alignment.pickPixels>100 && alignment.pickEqual && alignment.rgbaEqual && alignment.inputIntact && alignment.terrainVisible);
  assert.equal(alignment.negativePixels,0);
  assert.equal(alignment.failure.code,"INVALID_INPUT");
  assert.equal(alignment.cancelled.code,"REQUEST_CANCELLED");
  assert(alignment.failureAtomic && alignment.cancelAtomic);
  assert(alignment.heightError <= 1e-4);
  assert.deepEqual(alignment.axisControls.map(c=>c.axis),['east-west','north-south']);
  for(const control of alignment.axisControls)
    assert(control.pickPixels>100 && control.heightError>5 && !control.rgbaEqual);
  assert.equal(grids.missing.details.kind, "crs-missing-grid");
  assert.equal(grids.bestMissing.details.kind, "crs-missing-grid");
  assert.equal(grids.optional.code, "INVALID_INPUT");
  const d = results.datasets;
  assert(
    d.width === 256 &&
      d.height === 256 &&
      d.min < 0 &&
      d.max > 500 &&
      d.boundaries >= 3,
  );
  assert.equal(d.names.length, 12);
  const l = results.lifetime;
  assert.equal(l.cancellation.code, "REQUEST_CANCELLED");
  assert.equal(l.budget.code, "RESOURCE_LIMIT_EXCEEDED");
  assert.equal(l.disposal.code, "RUNTIME_DISPOSED");
  assert(
    l.diagnostics.workerCount === 0 &&
      l.diagnostics.pendingCalls === 0 &&
      l.diagnostics.assetBytes === 0 &&
      l.diagnostics.reservedBytes === 0,
  );
  assert.equal(results.lostDevice.gpuBytes, 0);
  assert.equal(results.lostDevice.lossReason, "destroyed");
  await context.setOffline(true);
  results.offline = await page.evaluate(() => window.__w14.offline());
  assert(Math.abs(results.offline.point[0][0] - 500000) <= 0.01);
  assert.equal(results.offline.datasets.digest, d.digest);
  assert(Math.abs(results.offline.grid[0][0] + 100.00040583667015) <= 1e-7);
  await context.setOffline(false);
  assert.deepEqual(errors, []);
  assert.deepEqual(remote, []);
  assert.deepEqual(projScriptRequests, []);
  assert.equal(hostileModuleExecutions, 0);
  mkdirSync(join(root, "test-results"), { recursive: true });
  writeFileSync(
    join(root, "test-results/w14-package-consumer.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        tarball: metadata.filename,
        sha256,
        installedPackage: true,
        csp,
        networkOffline: true,
        noRemoteRequests: true,
        noProjAssetScriptImports: true,
        hostileModuleExecutions,
        results,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    "W14 installed tarball, strict CSP, public declarations and fully offline fresh worker: PASS",
  );
} finally {
  await browser?.close();
  if (server) await new Promise((r) => server.close(r));
  const absolute = resolve(temp),
    base = resolve(tmpdir());
  if (
    !absolute.startsWith(base + sep) ||
    !absolute.split(sep).pop().startsWith("forge3d-w14-consumer-")
  )
    throw Error("Unsafe temporary cleanup");
  rmSync(absolute, { recursive: true, force: true });
}
