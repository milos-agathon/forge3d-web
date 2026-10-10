import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  cpSync,
  statSync,
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
} from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { resolveCommandInvocation } from "./command-executable.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(join(tmpdir(), "forge3d-w16-consumer-")),
  consumer = join(temp, "consumer"),
  pack = join(temp, "pack");
let browser, server;
function run(command, args, cwd = root) {
  const call = resolveCommandInvocation(command, args),
    r = spawnSync(call.command, call.args, {
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
    )[0],
    tarball = join(pack, metadata.filename),
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
  for (const path of [
    "types/pointcloud.d.ts",
    "types/copc.d.ts",
    "types/ept.d.ts",
    "types/tiles3d.d.ts",
    "types/pointcloud-renderer.d.ts",
    "assets/laz/laz-perf.js",
    "assets/laz/laz-perf.wasm",
    "assets/laz/laz-perf.LICENSE",
    "docs/pointcloud-tiles.md",
  ])
    assert(statSync(join(installed, path)).size > 0, path);
  writeFileSync(
    join(consumer, "consumer.ts"),
    `import {openCopc,openEpt,PointCloudLayer,PointCloudRenderer,PointCloudTraverser,AdaptivePointBudget,loadTileset,Tiles3dLayer,decodePnts,decodeB3dm,PointBuffer,transferPointData,createPointCloudWorkerHandler,Forge3DWorkerPool,type PointView} from '@forge3d/web';
const view:PointView={position:[0,0,10],viewportHeight:1080,fovY:Math.PI/4};const buffer=new PointBuffer({positions:new Float64Array([1,2,3])});const packet=transferPointData(buffer.data());const pool=new Forge3DWorkerPool({mainThreadHandler:createPointCloudWorkerHandler()});const budget=new AdaptivePointBudget();async function use(canvas:HTMLCanvasElement,url:URL){const dataset=await openCopc(url,{workerPool:pool});const layer=new PointCloudLayer(dataset,{adaptiveBudget:{targetFrameMs:33.3},ownsDataset:true});await layer.update(view);const renderer=await PointCloudRenderer.create(canvas);renderer.setLayers([layer]);const tiles=new Tiles3dLayer(await loadTileset(url));await tiles.update(view);tiles.dispose();renderer.dispose();layer.dispose();}void [use,openEpt,PointCloudTraverser,decodePnts,decodeB3dm,budget,packet];`,
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
  mkdirSync(join(consumer, "examples"));
  mkdirSync(join(consumer, "tests/fixtures"), { recursive: true });
  cpSync(
    join(root, "tests/fixtures/w16"),
    join(consumer, "tests/fixtures/w16"),
    { recursive: true },
  );
  for (const name of [
    "pointcloud-tiles.html",
    "w16-pointcloud.js",
    "w16-worker.js",
  ])
    writeFileSync(
      join(consumer, "examples", name),
      readFileSync(join(root, "examples", name), "utf8")
        .replaceAll("../dist/", "../node_modules/@forge3d/web/dist/")
        .replaceAll(
          "../src-ts/index.ts",
          "../node_modules/@forge3d/web/dist/index.js",
        ),
    );
  // Installed modules only. Real COPC range support is part of the consumer contract.
  server = createServer((req, res) => {
    try {
      const path = resolve(
          consumer,
          "." + new URL(req.url, "http://localhost").pathname,
        ),
        rel = relative(consumer, path);
      if (rel.startsWith("..") || isAbsolute(rel))
        throw Error("outside consumer");
      const bytes = readFileSync(path),
        headers = {
          "content-type":
            {
              ".html": "text/html",
              ".js": "text/javascript",
              ".json": "application/json",
              ".wasm": "application/wasm",
            }[extname(path)] ?? "application/octet-stream",
          "content-security-policy":
            "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
          "accept-ranges": "bytes",
        };
      if (req.headers.range) {
        const match = /^bytes=(\d+)-(\d+)$/u.exec(req.headers.range);
        if (!match) {
          res.writeHead(416);
          res.end();
          return;
        }
        const first = Number(match[1]),
          last = Math.min(Number(match[2]), bytes.length - 1);
        if (first > last) {
          res.writeHead(416, { "content-range": `bytes */${bytes.length}` });
          res.end();
          return;
        }
        res.writeHead(206, {
          ...headers,
          "content-range": `bytes ${first}-${last}/${bytes.length}`,
          "content-length": last - first + 1,
        });
        res.end(bytes.subarray(first, last + 1));
      } else {
        res.writeHead(200, { ...headers, "content-length": bytes.length });
        res.end(bytes);
      }
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
  const page = await browser.newPage(),
    errors = [],
    remote = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (message) => {
    if (message.text().startsWith("W16 progress ")) console.log(message.text());
  });
  page.on("request", (r) => {
    if (!r.url().startsWith(origin)) remote.push(r.url());
  });
  await page.addInitScript(() => {
    const gpu = navigator.gpu,
      request = gpu.requestAdapter.bind(gpu);
    gpu.requestAdapter = async (options) => {
      const adapter = await request(options);
      if (adapter) {
        const requestDevice = adapter.requestDevice.bind(adapter);
        adapter.requestDevice = async (options) => {
          const device = await requestDevice(options);
          window.__loseW16Device = () => device.destroy();
          return device;
        };
      }
      return adapter;
    };
  });
  await page.goto(origin + "/examples/pointcloud-tiles.html?dist");
  await page.waitForFunction(() => !!window.__w16);
  const io = await page.evaluate(() => window.__w16.io());
  for (const [actual, expected] of [
    [io.laz, io.manifest.autzen],
    [io.ept, io.manifest.ept],
  ]) {
    assert.equal(actual.count, expected.count);
    assert.equal(actual.positions, expected.positionsSha256);
    assert.equal(actual.colors, expected.colorsSha256);
  }
  assert.equal(io.copc.rootPositions, io.manifest.copcRoot.positionsSha256);
  assert.equal(io.copc.rootColors, io.manifest.copcRoot.colorsSha256);
  assert.equal(io.copc.count, 100000);
  assert.equal(io.copc.pointsRead, 100000);
  assert(io.copc.chunks > 1);
  assert.equal(io.copc.positions, io.manifest.copc.positionsSha256);
  assert.equal(io.copc.colors, io.manifest.copc.colorsSha256);
  assert.equal(io.tiles.stats.pointCount, 3);
  assert.equal(io.tiles.stats.triangles, 1);
  assert.equal(io.tiles.external, 1);
  assert.equal(io.worker.mode, "transferable");
  const ranges = await page.evaluate(() => window.__w16.ranged());
  assert(ranges.points > 0 && ranges.points <= 5000);
  assert(ranges.keys.includes("0-0-0-0"));
  assert.equal(ranges.rootPositions, ranges.expected.root.positionsSha256);
  assert.equal(ranges.rootColors, ranges.expected.root.colorsSha256);
  assert.deepEqual(ranges.expected.root.bounds, ranges.expected.bounds);
  assert(ranges.coveredPixels > 150);
  assert.deepEqual(ranges.negativeKeys, []);
  assert.equal(ranges.negativeCoveredPixels, 0);
  assert(ranges.fraction <= 0.25);
  assert(ranges.requests.every((r) => r.range !== null && r.status === 206));
  const failures = await page.evaluate(() => window.__w16.failures());
  assert.equal(failures.range.reason, "range-not-supported");
  assert.equal(failures.cancel.code, "REQUEST_CANCELLED");
  assert.equal(failures.budget.code, "RESOURCE_LIMIT_EXCEEDED");
  assert.equal(failures.corrupt.code, "INVALID_INPUT");
  const workload = await page.evaluate(() => window.__w16.workload());
  assert.equal(workload.count, 1000000);
  assert.equal(workload.layerCameras, 64);
  assert.equal(workload.cullingDifferences, 64);
  assert(workload.manifest.workloadEpt.topology.branchNodes > 400);
  assert(
    workload.manifest.workloadEpt.selectionCoverage.uniqueAdditiveSets >= 32,
  );
  for (let i = 0; i < workload.nodes.length; i++) {
    const a = workload.nodes[i],
      e = workload.manifest.workloadEpt.nodes[i];
    assert.equal(a.key, e.key);
    assert.equal(a.count, e.count);
    assert.equal(a.positions, e.positionsSha256);
    assert.equal(a.colors, e.colorsSha256);
  }
  assert.deepEqual(
    workload.cameras,
    workload.manifest.cameraSelections
      .filter((r) => r.source === "workload-ept")
      .map((r) => r.nodes),
  );
  const rendering = await page.evaluate(() => window.__w16.rendering());
  const tileReferences = await page.evaluate(() => window.__w16.tileReferences());
  assert.deepEqual(tileReferences.actual, tileReferences.expected);
  assert.equal(tileReferences.coverage.records, 256);
  assert(tileReferences.coverage.uniqueSelections >= 20);
  assert(rendering.lost);
  assert.equal(rendering.pressure.code, "RESOURCE_LIMIT_EXCEEDED");
  assert.equal(rendering.pressure.before, rendering.pressure.after);
  assert.equal(rendering.pressure.before, rendering.pressure.recovered);
  assert.equal(rendering.pressure.pick.pointIndex, 1);
  assert.deepEqual(rendering.styles, {
    rgb: [0, 255, 0],
    elevation: [0, 0, 255],
    intensity: rendering.styles.intensity,
    classification: [51, 102, 153],
  });
  assert(rendering.styles.intensity.every((x) => Math.abs(x - 128) <= 1));
  assert.equal(new Set(rendering.styles.intensity).size, 1);
  assert(Object.values(rendering.counts).every((n) => n > 150));
  assert.deepEqual(
    rendering.picks.map((p) => p.pointIndex),
    [0, 1, 2],
  );
  assert.equal(rendering.before, rendering.after);
  assert.equal(rendering.base.gpuBytes, rendering.stable.gpuBytes);
  assert.equal(rendering.disposed.gpuBytes, 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(remote, []);
  const meshes = await page.evaluate(() => window.__w16.meshRendering());
  assert(meshes.covered > 100);
  assert.equal(meshes.negative, 0);
  const report = {
    schemaVersion: 1,
    verifiedAt: new Date().toISOString(),
    browserVersion: browser.version(),
    platform: process.platform,
    packageSha256: sha256,
    io,
    ranges,
    failures,
    rendering,
    meshes,
    workload,
    tileReferences,
    pageErrors: errors,
    externalRequests: remote,
  };
  mkdirSync(join(root, "test-results"), { recursive: true });
  writeFileSync(
    join(root, "test-results/w16-package-consumer.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    JSON.stringify(
      {
        packageSha256: sha256,
        counts: [io.laz.count, io.copc.count, io.ept.count, workload.count],
        rangeFraction: ranges.fraction,
        deviceLoss: rendering.lost,
        pageErrors: errors,
        externalRequests: remote,
      },
      null,
      2,
    ),
  );
  if (process.env.FORGE3D_W16_SOAK === "1") {
    const target = process.env.FORGE3D_W16_PROFILE ?? "reference-discrete";
    const runs = Number(process.env.FORGE3D_W16_RUNS ?? 1);
    assert(Number.isInteger(runs) && runs >= 1 && runs <= 3, 'W16_RUNS must be 1..3');
    const retained = process.env.FORGE3D_W16_RETAIN_REPORTS === '1';
    const batchId = new Date().toISOString().replaceAll(/[^0-9TZ]/gu, '');
    if (retained) mkdirSync(join(root, 'docs/w16-runs'), { recursive: true });
    for (let runIndex = 1; runIndex <= runs; runIndex++) {
      console.log(`Starting W16 ten-minute installed-tarball run ${runIndex}/${runs}`);
      const result = await page.evaluate(
        (target) => window.__w16.soak(600000, target),
        target,
      );
      const observed = JSON.stringify(
        {
          ...result,
          verifiedAt: new Date().toISOString(),
          browserVersion: browser.version(),
          packageSha256: sha256,
          runIndex,
          batchId,
          fixtureSha256: createHash('sha256').update(readFileSync(join(root, 'tests/fixtures/w16/copc-ept-tiles-v1.json'))).digest('hex'),
          cameraHarnessSha256: createHash('sha256').update(readFileSync(join(root, 'examples/w16-pointcloud.js'))).digest('hex'),
        },
        null,
        2,
      ) + "\n";
      writeFileSync(join(root, 'test-results/w16-soak.json'), observed);
      writeFileSync(join(root, `test-results/w16-soak-${runIndex}.json`), observed);
      if (retained) writeFileSync(join(root, `docs/w16-runs/installed-${batchId}-${runIndex}.json`), observed);
      console.log(JSON.stringify({ runIndex, frames: result.frames, frameP95Ms: result.frameP95Ms,
        phases: result.phases, adapter: result.adapter, maxCpuBytes: result.maxCpuBytes,
        peakGpuBytes: result.stats.peakGpuBytes }));
      assert(result.durationMs >= 600000);
      assert.equal(result.keyframesVisited, 64);
      assert.equal(result.totalPoints, 1000000);
      assert(result.selectionCount >= 32);
      assert(result.minPoints < result.maxPoints);
      assert(result.maxPoints <= 300000);
      assert(result.coveredPixels > 150);
      assert(result.maxCpuBytes <= result.budgets.cpuBudgetBytes);
      assert(result.stats.peakGpuBytes <= result.budgets.gpuBudgetBytes);
      assert(result.stats.peakGpuBytes <= result.stats.memoryBudgetBytes);
      assert.equal(result.disposed.gpuBytes, 0);
      assert(result.frameP95Ms <= result.budgets.p95Ms,
        `W16 p95 ${result.frameP95Ms.toFixed(1)} ms exceeds ${result.budgets.p95Ms} ms`);
      assert.deepEqual(errors, []);
      assert.deepEqual(remote, []);
    }
  }
} finally {
  await browser?.close();
  if (server) await new Promise((r) => server.close(r));
}
