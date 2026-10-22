import { installedRun } from "./installed-run.mjs";
import { installedFixtureHandler } from "./fixture-http.mjs";
import { attachInstalledSuite } from "./installed-artifact.mjs";
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
await installedRun({suite:"w22",destination:join(root,"test-results/w22-package-consumer.json"),requiredPhases:["setup","browser"]}, async evidence => {
const temp = mkdtempSync(join(tmpdir(), "forge3d-w22-consumer-"));
const consumer = join(temp, "consumer");
const artifact = attachInstalledSuite({ packageRoot: root, consumer, suite: "w22" });
const { metadata, tarball, packageSha256 } = artifact;
evidence.artifact(artifact);
run("npm", ["run", "test:api"]);
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
const server = createServer(installedFixtureHandler({
  route(pathname) {
    if (!["/dist/", "/assets/", "/examples/", "/tests/fixtures/w22/"].some(prefix=>pathname.startsWith(prefix))) return null;
    const servedRoot = pathname.startsWith("/tests/fixtures/w22/") || pathname === "/examples/test-w06-capture.html" ? root : installed;
    return {root:servedRoot};
  },
  headers: {"cross-origin-opener-policy":"same-origin","cross-origin-embedder-policy":"require-corp"},
  hashInlineScripts:true,
}));

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
  evidence.phase("browser");
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
  evidence.observe({exitCode:result,servedRoot:installed,externalTestInputs:root});
  assert.equal(result, 0, "Installed W22 probes failed");
} finally {
  await new Promise((r) => server.close(r));
}

});
