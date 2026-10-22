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
await installedRun({suite:"w18",destination:join(root,"test-results/w18-package-consumer.json"),requiredPhases:["setup","browser"]}, async evidence => {
const temp = mkdtempSync(join(tmpdir(), "forge3d-w18-consumer-"));
const consumer = join(temp, "consumer");
const artifact = attachInstalledSuite({ packageRoot: root, consumer, suite: "w18" });
const { metadata, tarball, packageSha256 } = artifact;
evidence.artifact(artifact);
run("npm", ["run", "test:api"]);
const installed = join(consumer, "node_modules/@forge3d/web");
for (const file of [
  "dist/map-scene.js", "dist/diagnostics.js", "dist/diagnostic-style.js", "dist/map-render.js",
  "types/map-scene.d.ts", "types/map-recipe.d.ts", "types/map-scene-types.d.ts",
  "types/diagnostics.d.ts", "docs/mapscene-diagnostics.md", "dist/forge3d_web_bg.wasm"
])
  assert(statSync(join(installed, file)).size > 0, file);
writeFileSync(
  join(consumer, "consumer.ts"),
  `import {MapScene,SceneRecipe,TerrainSource,OrbitCamera,OutputSpec,LightingPreset,ReproducibilityProfile,MapSceneLabelLayer,Diagnostic,ValidationReport,RenderFailurePolicy,getMapSceneSupportMatrix,validateStyleSupport,type SceneRecipeInput} from '@forge3d/web';
const recipe:SceneRecipeInput={crs:'LOCAL',terrain:new TerrainSource({source:{id:'dem',format:'heightmap',crs:'LOCAL',data:{width:2,height:2,heights:new Float32Array([0,1,1,0])}}}),camera:new OrbitCamera({target:[0,0,0],distance:10}),output:new OutputSpec({width:64,height:48}),lighting:new LightingPreset({name:'daylight'}),reproducibility:new ReproducibilityProfile({seed:7})};
const label=new MapSceneLabelLayer({layerId:'labels',source:{id:'labels',format:'labels',crs:'LOCAL',data:[]},coordinateSpace:'screen'});label.coordinateSpace;
const scene=new MapScene(new SceneRecipe(recipe)),report:ValidationReport=scene.validate();report.renderBlocked(RenderFailurePolicy.FAIL_ON_WARNING);Diagnostic.fromJSON({code:'test',severity:'warning',message:'message',remediation:'fix'});validateStyleSupport({layers:[{id:'land',type:'fill'}]});getMapSceneSupportMatrix();
async function render(){const result=await scene.render({signal:new AbortController().signal,sink:new WritableStream<Uint8Array>()});result.frame.data;result.blob;const review=await scene.reviewRecord();review.compiled_label_plans;review.recipe_hash;scene.dispose();}void render;`,
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
  if(["/examples/","/tests/fixtures/w18/","/tests/fixtures/w16/"].some(prefix=>pathname.startsWith(prefix))) return {root};
  return null;
 }, headers:{"cross-origin-opener-policy":"same-origin","cross-origin-embedder-policy":"require-corp"},
 transform(bytes,path) {return extname(path)===".html" ? Buffer.from(bytes.toString("utf8").replaceAll("../src-ts/index.ts","/dist/index.js").replaceAll("/src-ts/index.ts","/dist/index.js")) : bytes;},
}));

let result;
try {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const out = join(root, "test-results");
  mkdirSync(out, { recursive: true });
  // Playwright clears outputDir before workers import the config.
  const config = join(temp, "w18-package.config.mts");
  writeFileSync(
    config,
    `import config from ${JSON.stringify(pathToFileURL(join(root, "playwright.config.ts")).href)};export default {...config,testDir:${JSON.stringify(join(root, "tests/playwright"))},testMatch:'w18_mapscene.spec.ts',outputDir:${JSON.stringify(join(out, "w18-installed-output"))},webServer:undefined,use:{...config.use,baseURL:${JSON.stringify(origin)}},reporter:[['list'],['json',{outputFile:${JSON.stringify(join(out, "w18-installed-playwright.json"))}}]]};`,
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
        "W18 dist",
        "--workers=1",
      ],
      {
        cwd: root,
        stdio: "inherit",
        env: {
          ...process.env,
          FORGE3D_W18_INSTALLED: "1",
          FORGE3D_W18_SOAK: process.argv.includes("--soak") ? "1" : "0",
        },
      },
    );
    child.on("error", reject);
    child.on("exit", (code) => resolveResult(code));
  });
  evidence.observe({exitCode:result,servedRoot:installed});
  assert.equal(result, 0, "Installed W18 probes failed");
} finally {
  await new Promise((r) => server.close(r));
}

});
