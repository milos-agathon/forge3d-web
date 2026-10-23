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
await installedRun({suite:"w17",destination:join(root,"test-results/w17-package-consumer.json"),requiredPhases:["setup","browser"]}, async evidence => {
const temp = mkdtempSync(join(tmpdir(), "forge3d-w17-consumer-"));
const consumer = join(temp, "consumer");
const artifact = attachInstalledSuite({ packageRoot: root, consumer, suite: "w17" });
const { metadata, tarball, packageSha256 } = artifact;
evidence.artifact(artifact);
run("npm", ["run", "test:api"]);
const installed = join(consumer, "node_modules/@forge3d/web");
for (const file of [
  "dist/path-tracer.js",
  "dist/bvh-gpu.js",
  "dist/trace-wgsl.js",
  "dist/trace-worker.js",
  "types/path-tracer.d.ts",
  "types/trace-types.d.ts",
  "docs/tracing.md",
  "dist/forge3d_web_bg.wasm",
])
  assert(statSync(join(installed, file)).size > 0, file);
writeFileSync(
  join(consumer, "consumer.ts"),
  `import {PathTracer,SdfSceneBuilder,buildBvh,buildBvhWasm,buildBvhGpu,refitBvhGpu,traceRaysGpu,evaluateSdfGpu,evaluateSdfWasm,OnlineGuidingGrid,RestirDI,iterTraceTiles,encodeTraceAovs,createTraceWorkerHandler,Forge3DWorkerPool,type TraceTriangle} from '@forge3d/web';
const triangles:TraceTriangle[]=[{v0:[-1,-1,0],v1:[1,-1,0],v2:[0,1,0],id:1}];
const builder=new SdfSceneBuilder();builder.addSphere([0,0,0],1);const sdf=builder.build();const grid=new OnlineGuidingGrid(8,8);const restir=new RestirDI();restir.addLight({position:[0,3,5]});
async function render(){const t=await PathTracer.create({width:8,height:8,guiding:grid,restir:{initialCandidates:8},engine:'wavefront'});await t.setScene({triangles,sdf});for await(const update of t.progressive({spp:4})){update.result.id[0];}await t.renderHdr();t.dispose();}
const pool=new Forge3DWorkerPool({mainThreadHandler:createTraceWorkerHandler()});void [iterTraceTiles,encodeTraceAovs,render,pool,buildBvh,buildBvhWasm,buildBvhGpu,refitBvhGpu,traceRaysGpu,evaluateSdfGpu,evaluateSdfWasm];`,
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
const server = createServer(installedFixtureHandler({
 route(pathname) {
  if(["/dist/","/assets/"].some(prefix=>pathname.startsWith(prefix))) return {root:installed};
  if(["/examples/","/tests/fixtures/w17/"].some(prefix=>pathname.startsWith(prefix))) return {root};
  return null;
 },
 transform(bytes,path) {return extname(path)===".html" ? Buffer.from(bytes.toString("utf8").replaceAll("../src-ts/index.ts","/dist/index.js").replaceAll("/src-ts/index.ts","/dist/index.js")) : bytes;},
}));

let result;
try {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const out = join(root, "test-results");
  mkdirSync(out, { recursive: true });
  // Playwright clears outputDir before workers import the config.
  const config = join(temp, "w17-package.config.mts");
  writeFileSync(
    config,
    `import config from ${JSON.stringify(pathToFileURL(join(root, "playwright.config.ts")).href)};export default {...config,testDir:${JSON.stringify(join(root, "tests/playwright"))},testMatch:'w17_tracing.spec.ts',outputDir:${JSON.stringify(join(out, "w17-installed-output"))},webServer:undefined,use:{...config.use,baseURL:${JSON.stringify(origin)}},reporter:[['list'],['json',{outputFile:${JSON.stringify(join(out, "w17-installed-playwright.json"))}}]]};`,
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
        "W17 dist",
        "--workers=1",
      ],
      {
        cwd: root,
        stdio: "inherit",
        env: {
          ...process.env,
          FORGE3D_W17_INSTALLED: "1",
          FORGE3D_W17_SOAK: process.argv.includes("--soak") ? "1" : "0",
        },
      },
    );
    child.on("error", reject);
    child.on("exit", (code) => resolveResult(code));
  });
  evidence.observe({exitCode:result,servedRoot:installed});
  assert.equal(result, 0, "Installed W17 probes failed");
} finally {
  await new Promise((r) => server.close(r));
}

});
