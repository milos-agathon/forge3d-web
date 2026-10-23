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
await installedRun({suite:"w21",destination:join(root,"test-results/w21-package-consumer.json"),requiredPhases:["setup","browser"]}, async evidence => {
const temp = mkdtempSync(join(tmpdir(), "forge3d-w21-consumer-"));
const consumer = join(temp, "consumer");
const artifact = attachInstalledSuite({ packageRoot: root, consumer, suite: "w21" });
const { metadata, tarball, packageSha256 } = artifact;
evidence.artifact(artifact);
run("npm", ["run", "test:api"]);
const installed = join(consumer, "node_modules/@forge3d/web");
for (const file of [
  "dist/license.js", "dist/image-array.js", "dist/png-decode.js", "dist/benchmark.js", "dist/vendor/noble-ed25519.js", "dist/vendor/noble-hashes/sha2.js", "dist/vendor/fflate.js",
  "types/license.d.ts", "types/image-array.d.ts", "types/benchmark.d.ts",
  "docs/utilities.md", "dist/forge3d_web_bg.wasm"
])
  assert(statSync(join(installed, file)).size > 0, file);
writeFileSync(join(consumer,"consumer.ts"),`import {configureLicenseIssuer,LicenseManager,setLicenseKey,requirePro,arrayToPng,pngToArray,decodePng,displayImageArray,runBenchmark,RendererConfig,type BenchmarkOptions,type BenchmarkResult,type PersistentByteStore} from '@forge3d/web';
const image={width:2,height:1,channels:4 as const,data:new Uint8Array(8)};
async function workflow(store:PersistentByteStore){configureLicenseIssuer('11'.repeat(32));await setLicenseKey('');const manager=new LicenseManager({verifier:'noble'});await manager.load(store);const png:Blob=await arrayToPng(image);await pngToArray(png);const opts:BenchmarkOptions={op:'array_to_png',width:2,height:1,renderer:new RendererConfig({quality:'low'})};const report:BenchmarkResult=await runBenchmark(opts);const cold:number=report.coldMs;const quality=report.renderer?.quality;await runBenchmark({...opts,baseline:report,maxRegressionPercent:50});void cold;void quality;return report.schemaVersion;}void workflow;void requirePro;void decodePng;void displayImageArray;`);
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
    if (!["/dist/", "/assets/", "/examples/", "/tests/fixtures/w21/"].some(prefix=>pathname.startsWith(prefix))) return null;
    const servedRoot = installed;
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
  const config = join(temp, "w21-package.config.mts");
  writeFileSync(
    config,
    `import config from ${JSON.stringify(pathToFileURL(join(root, "playwright.config.ts")).href)};export default {...config,testDir:${JSON.stringify(join(root, "tests/playwright"))},testMatch:'w21_utilities.spec.ts',outputDir:${JSON.stringify(join(out, "w21-installed-output"))},webServer:undefined,use:{...config.use,baseURL:${JSON.stringify(origin)}},reporter:[['list'],['json',{outputFile:${JSON.stringify(join(out, "w21-installed-playwright.json"))}}]]};`,
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
        "W21 dist",
        "--workers=1",
        "--max-failures=1",
      ],
      {
        cwd: root,
        stdio: "inherit",
        env: {
          ...process.env,
          FORGE3D_W21_INSTALLED: "1",
          FORGE3D_W21_SOAK: process.argv.includes("--soak") ? "1" : "0",
        },
      },
    );
    child.on("error", reject);
    child.on("exit", (code) => resolveResult(code));
  });
  evidence.observe({exitCode:result,servedRoot:installed});
  assert.equal(result, 0, "Installed W21 probes failed");
} finally {
  await new Promise((r) => server.close(r));
}

});
