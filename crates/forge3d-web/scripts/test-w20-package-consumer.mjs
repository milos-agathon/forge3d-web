import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
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
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveCommandInvocation } from "./command-executable.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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
assert.equal(
  run("git", ["status", "--porcelain"]).trim(),
  "",
  "W20 installed gate requires a clean committed worktree",
);
run("npm", ["run", "build:wasm"]);
run("npm", ["run", "build:ts"]);
run("npm", ["run", "prepare-dist"]);
run("npm", ["run", "test:api"]);
assert.equal(
  run("git", ["status", "--porcelain"]).trim(),
  "",
  "Generated declarations must be committed",
);
const temp = mkdtempSync(join(tmpdir(), "forge3d-w20-consumer-")),
  consumer = join(temp, "consumer"),
  pack = join(temp, "pack");
mkdirSync(consumer);
mkdirSync(pack);
const metadata = JSON.parse(
    run("npm", ["pack", "--json", "--pack-destination", pack]),
  )[0],
  tarball = join(pack, metadata.filename),
  packageSha256 = createHash("sha256")
    .update(readFileSync(tarball))
    .digest("hex");
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
for (const file of ['dist/map-plate.js','dist/vector-export.js','dist/vector-pdf.js','dist/colormaps.js','dist/vendor/pdf-lib.js','dist/vendor/fontkit.umd.js','dist/vendor/fontkit.js','dist/vendor/pdf-lib.LICENSE','dist/vendor/fontkit.LICENSE','types/map-plate.d.ts','types/vector-export.d.ts','types/colormaps.d.ts','docs/cartography.md','examples/cartography.html','dist/forge3d_web_bg.wasm']) assert(statSync(join(installed,file)).size>0,file);
writeFileSync(join(consumer,'consumer.ts'),`import {MapPlate,BBox,Legend,ScaleBar,NorthArrow,ColormapRegistry,colormaps,parseColormapCpt,parseColormapJson,loadColormap,VectorScene,Bounds,exportSvg,exportPdf,type VectorPdfOptions,type MapPlateConfig} from '@forge3d/web';
const config:MapPlateConfig={width:800,height:600}; const plate=new MapPlate(config),bbox=new BBox(0,0,1,1),cm=colormaps.get('forge3d:viridis');
async function output(){plate.addLegend(await new Legend(cm,[0,1000]).render());plate.addScaleBar(await new ScaleBar(100).render());plate.addNorthArrow(await new NorthArrow().render());const png:Blob=await plate.exportPng();const jpeg:Blob=await plate.exportJpeg();const scene=new VectorScene().addLabel('Map',[0,0]);const svg:Blob=await exportSvg(scene);const opts:VectorPdfOptions={bounds:new Bounds()};const pdf:Blob=await exportPdf(scene,opts);plate.dispose();scene.dispose();return[png,jpeg,svg,pdf];}void output;void bbox;void ColormapRegistry;void parseColormapCpt;void parseColormapJson;void loadColormap;`);
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
const server = createServer((req, res) => {
  try {
    const url = new URL(req.url, "http://localhost"),
      pathname = decodeURIComponent(url.pathname);
    if (!['/dist/', '/assets/', '/examples/', '/tests/fixtures/w20/'].some(prefix => pathname.startsWith(prefix))) throw Error('consumer route unavailable');
    const path = resolve(installed, '.' + pathname), rel = relative(installed, path);
    if (rel.startsWith('..') || isAbsolute(rel)) throw Error('outside consumer');
    let bytes = readFileSync(path);
    // HTML parsing normalizes CRLF and lone CR before CSP hashes inline scripts.
    const scriptHashes = extname(path) === '.html' ? [...bytes.toString('utf8').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m => "'sha256-" + createHash('sha256').update(m[1].replace(/\r\n?/g, '\n')).digest('base64') + "'") : [];
    const headers={
      "content-type": {".html":"text/html", ".js":"text/javascript", ".mjs":"text/javascript", ".json":"application/json", ".wasm":"application/wasm", ".ttf":"font/ttf", ".png":"image/png"}[extname(path)] ?? "application/octet-stream",
      "cross-origin-opener-policy":"same-origin", "cross-origin-embedder-policy":"require-corp", "accept-ranges":"bytes"
    };
    if (extname(path) === '.html') headers['content-security-policy'] = `default-src 'self'; script-src 'self' 'wasm-unsafe-eval' ${scriptHashes.join(' ')}; worker-src 'self'; connect-src 'self' blob:; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; font-src 'self'; object-src 'none'`;
    const range=req.headers.range;
    if(range){const match=/^bytes=(\d+)-(\d*)$/.exec(range);if(!match)throw Error("invalid Range");const start=Number(match[1]),end=match[2]?Math.min(Number(match[2]),bytes.length-1):bytes.length-1;if(start>end||start>=bytes.length){res.writeHead(416);res.end();return;}headers['content-range']=`bytes ${start}-${end}/${bytes.length}`;bytes=bytes.subarray(start,end+1);res.writeHead(206,{...headers,'content-length':bytes.length});}
    else res.writeHead(200,{...headers,'content-length':bytes.length});
    res.end(bytes);
  } catch {
    res.writeHead(404);
    res.end("Missing installed resource");
  }
});
let result;
try {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const out = join(root, "test-results");
  mkdirSync(out, { recursive: true });
  // Playwright clears outputDir before workers import the config.
  const config = join(temp, "w20-package.config.mts");
  writeFileSync(
    config,
    `import config from ${JSON.stringify(pathToFileURL(join(root, "playwright.config.ts")).href)};export default {...config,testDir:${JSON.stringify(join(root, "tests/playwright"))},testMatch:'w20_cartography.spec.ts',outputDir:${JSON.stringify(join(out, "w20-installed-output"))},webServer:undefined,use:{...config.use,baseURL:${JSON.stringify(origin)}},reporter:[['list'],['json',{outputFile:${JSON.stringify(join(out, "w20-installed-playwright.json"))}}]]};`,
  );
  result = await new Promise((resolveResult, reject) => {
    const child = spawn(
      process.execPath,
      [
        join(root, "node_modules/@playwright/test/cli.js"),
        "test",
        "--config",
        config,
        "--project=chromium-preflight",
        "--grep",
        "W20 dist",
        "--workers=1",
        "--max-failures=1",
      ],
      {
        cwd: root,
        stdio: "inherit",
        env: {
          ...process.env,
          FORGE3D_W20_INSTALLED: "1",
          FORGE3D_W20_SOAK: process.argv.includes("--soak") ? "1" : "0",
        },
      },
    );
    child.on("error", reject);
    child.on("exit", (code) => resolveResult(code));
  });
  if (result === 0) { const rendered = run('python', [join(root, 'scripts/verify-w20-pdf.py'), join(out, 'w20-installed-playwright.json')]); writeFileSync(join(out,'w20-pdf-render.json'),rendered); console.log(rendered); }
  const report = {
    schemaVersion: 1,
    verifiedAt: new Date().toISOString(),
    revision: run("git", ["rev-parse", "HEAD"]).trim(),
    packageSha256,
    wasmSha256: createHash("sha256").update(readFileSync(join(installed, "dist/forge3d_web_bg.wasm"))).digest("hex"),
    wasmRebuilt: true,
    servedRoot: installed,
    tarball,
    installed,
    exitCode: result,
  };
  writeFileSync(
    join(out, "w20-package-consumer.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
  assert.equal(result, 0, "Installed W20 probes failed");
} finally {
  await new Promise((r) => server.close(r));
}
