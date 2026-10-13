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
  "W19 installed gate requires a clean committed worktree",
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
const temp = mkdtempSync(join(tmpdir(), "forge3d-w19-consumer-")),
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
for (const file of [
  "dist/map-scene.js", "dist/map-style.js", "dist/bundle.js", "dist/scene-review.js", "dist/vendor/fflate.js", "dist/vendor/fflate.LICENSE",
  "types/map-scene.d.ts", "types/map-recipe.d.ts", "types/map-scene-types.d.ts",
  "types/diagnostics.d.ts", "docs/styles-bundles.md", "dist/forge3d_web_bg.wasm"
])
  assert(statSync(join(installed, file)).size > 0, file);
writeFileSync(join(consumer,"consumer.ts"),`import {MapScene,SceneState,StyleSpec,parseStyle,compileStyle,loadStyle,saveBundle,loadBundle,SpriteAtlas,loadGlyphRanges,type SceneRecipeInput,type SceneVariant,type ReviewLayer} from '@forge3d/web';
const recipe:SceneRecipeInput={crs:'LOCAL',camera:{kind:'orbit-camera',target:[0,0,0],distance:10},output:{width:64,height:48}};
const variant:SceneVariant={id:'plain',activeLayerIds:[]},layer:ReviewLayer={id:'notes',layers:[]};
const state=new SceneState({base:recipe,variants:[variant],reviewLayers:[layer]});
const scene=MapScene.fromSceneState(state),style:StyleSpec=parseStyle({version:8,layers:[]});compileStyle(style,{});
async function roundtrip(){const blob:Blob=await scene.saveBundle();const replacement=await MapScene.loadBundle(blob);await replacement.applyVariant('plain');const loaded=await loadBundle(await saveBundle(state));loaded.dispose();replacement.dispose();scene.dispose();}void roundtrip;void loadStyle;void SpriteAtlas;void loadGlyphRanges;`);
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
    if (!['/dist/', '/assets/', '/examples/', '/tests/fixtures/w19/'].some(prefix => pathname.startsWith(prefix))) throw Error('consumer route unavailable');
    const path = resolve(installed, '.' + pathname), rel = relative(installed, path);
    if (rel.startsWith('..') || isAbsolute(rel)) throw Error('outside consumer');
    let bytes = readFileSync(path);
    const scriptHashes = extname(path) === '.html' ? [...bytes.toString('utf8').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m => "'sha256-" + createHash('sha256').update(m[1]).digest('base64') + "'") : [];
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
  const config = join(temp, "w19-package.config.mts");
  writeFileSync(
    config,
    `import config from ${JSON.stringify(pathToFileURL(join(root, "playwright.config.ts")).href)};export default {...config,testDir:${JSON.stringify(join(root, "tests/playwright"))},testMatch:'w19_style_bundle.spec.ts',webServer:undefined,use:{...config.use,baseURL:${JSON.stringify(origin)}},reporter:[['list'],['json',{outputFile:${JSON.stringify(join(out, "w19-installed-playwright.json"))}}]]};`,
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
        "W19 dist",
        "--workers=1",
      ],
      {
        cwd: root,
        stdio: "inherit",
        env: {
          ...process.env,
          FORGE3D_W19_INSTALLED: "1",
          FORGE3D_W19_SOAK: process.argv.includes("--soak") ? "1" : "0",
        },
      },
    );
    child.on("error", reject);
    child.on("exit", (code) => resolveResult(code));
  });
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
    join(out, "w19-package-consumer.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
  assert.equal(result, 0, "Installed W19 probes failed");
} finally {
  await new Promise((r) => server.close(r));
}
