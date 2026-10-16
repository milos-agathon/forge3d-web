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
  "W22 installed gate requires a clean committed worktree",
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
const temp = mkdtempSync(join(tmpdir(), "forge3d-w22-consumer-")),
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
assert(!metadata.files.some(file => file.path.startsWith('tests/fixtures/w22/')), 'W22 test data must not ship in the tarball');
for (const file of [
  'dist/codec-registry.js','dist/codec-catalog.js','dist/codec-dispatch.js','dist/codec-denoiser.js',
  'types/codec-registry.d.ts','types/codec-types.d.ts','docs/codecs.md','examples/codecs.html',
  'examples/codecs.js','dist/forge3d_web_bg.wasm'
]) assert(statSync(join(installed,file)).size>0,file);
writeFileSync(join(consumer,'consumer.ts'),`import { CodecRegistry, Forge3DSession, HdrFrame, AovFrame, type CodecResult, type CodecRegistryOptions } from '@forge3d/web';
async function workflow(session:Forge3DSession,frame:HdrFrame,guides:AovFrame,options:CodecRegistryOptions){const r=new CodecRegistry(options);const value:CodecResult<'hdr'>=await r.decode('hdr',new Blob([]));const channel:number=value.value.data[0];await r.replay(value.cacheKey,{format:'hdr'});const result:HdrFrame=await r.denoise(session,frame,guides);await r.dispose();return result;}void workflow;`);
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
    if (!['/dist/', '/assets/', '/examples/', '/tests/fixtures/w22/'].some(prefix => pathname.startsWith(prefix))) throw Error('consumer route unavailable');
    // Test inputs and the original W06 fixture harness are external to the tarball.
    // Every implementation module/worker/WASM asset must resolve from installed.
    const fixture = pathname.startsWith('/tests/fixtures/w22/') || pathname === '/examples/test-w06-capture.html';
    const servedRoot = fixture ? root : installed;
    const path = resolve(servedRoot, '.' + pathname), rel = relative(servedRoot, path);
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
  const config = join(temp, "w22-package.config.mts");
  writeFileSync(
    config,
    `import config from ${JSON.stringify(pathToFileURL(join(root, "playwright.config.ts")).href)};export default {...config,testDir:${JSON.stringify(join(root, "tests/playwright"))},testMatch:'w22_codecs.spec.ts',outputDir:${JSON.stringify(join(out, "w22-installed-output"))},webServer:undefined,use:{...config.use,baseURL:${JSON.stringify(origin)}},reporter:[['list'],['json',{outputFile:${JSON.stringify(join(out, "w22-installed-playwright.json"))}}]]};`,
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
        "W22 dist",
        "--workers=1",
        "--max-failures=1",
      ],
      {
        cwd: root,
        stdio: "inherit",
        env: {
          ...process.env,
          FORGE3D_W22_INSTALLED: "1",
          FORGE3D_W22_SOAK: process.argv.includes("--soak") ? "1" : "0",
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
    externalTestInputs: root,
    tarball,
    installed,
    exitCode: result,
  };
  writeFileSync(
    join(out, "w22-package-consumer.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
  assert.equal(result, 0, "Installed W22 probes failed");
} finally {
  await new Promise((r) => server.close(r));
}
