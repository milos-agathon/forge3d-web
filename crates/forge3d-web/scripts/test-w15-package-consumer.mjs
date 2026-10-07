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
const temp = mkdtempSync(join(tmpdir(), "forge3d-w15-consumer-")),
  consumer = join(temp, "consumer"),
  pack = join(temp, "pack");
let browser, server;
function run(command, args, cwd = root) {
  const invocation = resolveCommandInvocation(command, args),
    r = spawnSync(invocation.command, invocation.args, {
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
    "types/mesh.d.ts",
    "types/geometry.d.ts",
    "types/buildings.d.ts",
    "types/mesh-gltf.d.ts",
    "docs/geometry-mesh-io.md",
  ])
    assert(statSync(join(installed, path)).size > 0, path);
  writeFileSync(
    join(consumer, "consumer.ts"),
    `import {generatePrimitive,attachMeshTangents,subdivideMesh,MeshLayer,loadGltf,loadBuildings,exportMeshToSink,transferMesh,createMeshWorkerHandler,Forge3DWorkerPool,type MeshBuffers,type BuildingTextureReport,diagnoseBuildingTextures} from '@forge3d/web';
const mesh:MeshBuffers=subdivideMesh(attachMeshTangents(generatePrimitive('plane')));const layer=new MeshLayer(mesh);const payload=transferMesh(mesh);const report:BuildingTextureReport=diagnoseBuildingTextures([]);const pool=new Forge3DWorkerPool({mainThreadHandler:createMeshWorkerHandler()});async function use(blob:Blob){const gltf=await loadGltf(blob);const buildings=await loadBuildings(blob);await exportMeshToSink(gltf.primitives[0]!.mesh,'glb',{kind:'stream',stream:new WritableStream<Uint8Array>()});buildings.dispose();}void [layer,payload,report,pool,use];`,
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
    join(root, "tests/fixtures/w15"),
    join(consumer, "tests/fixtures/w15"),
    { recursive: true },
  );
  for (const name of [
    "mesh-buildings.html",
    "w15-geometry.js",
    "w15-worker.js",
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
  // Only installed files and copied data/example assets are served.
  server = createServer((req, res) => {
    try {
      const path = resolve(
          consumer,
          "." + new URL(req.url, "http://localhost").pathname,
        ),
        rel = relative(consumer, path);
      if (rel.startsWith("..") || isAbsolute(rel))
        throw Error("outside consumer");
      const bytes = readFileSync(path);
      res.writeHead(200, {
        "content-type":
          {
            ".html": "text/html",
            ".js": "text/javascript",
            ".json": "application/json",
            ".wasm": "application/wasm",
          }[extname(path)] ?? "application/octet-stream",
        "content-security-policy":
          "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
        "content-length": bytes.length,
      });
      res.end(bytes);
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
  page.on("request", (r) => {
    if (!r.url().startsWith(origin)) remote.push(r.url());
  });
  await page.goto(origin + "/examples/mesh-buildings.html?dist");
  await page.waitForFunction(() => !!window.__w15);
  const io = await page.evaluate(() => window.__w15.io());
  assert.equal(io.familyRoundtrips.length, 15);
  for (const r of io.familyRoundtrips) {
    assert.equal(r.triangles, r.expectedTriangles);
    assert.equal(r.vertices, r.expectedVertices);
    assert(r.topology);
    for (const key of [
      "positionError",
      "boundsError",
      "normalError",
      "uvError",
      "tangentError",
    ])
      assert(r[key] === null || r[key] <= 1e-5, `${r.name} ${r.format} ${key}`);
  }
  for (const r of io.roundtrips) {
    assert(r.topology);
    assert.equal(r.vertices, 3);
    assert.equal(r.triangles, 1);
    assert(
      r.positionError <= 1e-5 &&
        r.normalError <= 1e-5 &&
        (r.uvError === null || r.uvError <= 1e-5),
    );
  }
  assert(io.pngExact && io.hdrError <= 1e-5);
  assert.equal(io.cancelled, "REQUEST_CANCELLED");
  assert.equal(io.budget, "RESOURCE_LIMIT_EXCEEDED");
  assert.equal(io.diagnostics.status, "error");
  assert.deepEqual(io.plainCounts, [1, 1, 1]);
  const worker = await page.evaluate(() => window.__w15.worker());
  assert(
    worker.inputDetached &&
      worker.ownedIntact &&
      worker.returnedDetached &&
      worker.valid,
  );
  assert.equal(worker.mode, "transferable");
  assert.equal(worker.triangles, 128);
  const geometry = await page.evaluate(() => window.__w15.buildings());
  assert(Math.abs(geometry.projectedBounds.min[0]) <= 1e-4);
  assert(geometry.projectedBounds.max[0] > 3000);
  assert.equal(Object.keys(geometry.counts).length, 2);
  assert(Object.values(geometry.counts).every((n) => n > 100));
  assert.deepEqual(geometry.materialIndices, [2, 3]);
  assert.equal(geometry.far.lodInstanceCounts[1], 2);
  const textures = await page.evaluate(() => window.__w15.textures());
  assert(
    textures.covered > 100 &&
      textures.colors > 3 &&
      textures.normalError <= 1e-5 &&
      textures.albedoError <= 1e-5 &&
      textures.idsEqual &&
      textures.uvNegativeDelta > 0.1,
  );
  const resources = await page.evaluate(() => window.__w15.resources());
  assert(resources.stable && resources.atomic);
  assert.equal(resources.rejected, "RESOURCE_LIMIT_EXCEEDED");
  assert.equal(resources.cleared, 0);
  assert.equal(resources.resized, 128 * 80 * 4);
  const recovery = await page.evaluate(() => window.__w15.recovery());
  assert(recovery.same);
  assert.equal(recovery.created, 2);
  assert.equal(recovery.stats.visibleInstances, 2);
  assert.deepEqual(errors, []);
  assert.deepEqual(remote, []);
  const report = {schemaVersion:1, verifiedAt:new Date().toISOString(), browserVersion:browser.version(), platform:process.platform, packageSha256:sha256, io, worker, geometry, textures, resources, recovery, pageErrors:errors, externalRequests:remote};
  mkdirSync(join(root,"test-results"),{recursive:true});
  const reportPath=join(root,"test-results/w15-package-consumer.json");
  writeFileSync(reportPath,JSON.stringify(report,null,2)+"\n");
  console.log(JSON.stringify(report,null,2));
  console.log(`W15 installed-package evidence: ${reportPath}`);
} finally {
  await browser?.close();
  if (server) await new Promise((r) => server.close(r));
}
