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
await installedRun({suite:"w19",destination:join(root,"test-results/w19-package-consumer.json"),requiredPhases:["setup","browser"]}, async evidence => {
const temp = mkdtempSync(join(tmpdir(), "forge3d-w19-consumer-"));
const consumer = join(temp, "consumer");
const artifact = attachInstalledSuite({ packageRoot: root, consumer, suite: "w19" });
const { metadata, tarball, packageSha256 } = artifact;
evidence.artifact(artifact);
run("npm", ["run", "test:api"]);
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
const server = createServer(installedFixtureHandler({
  route(pathname) {
    if (!["/dist/", "/assets/", "/examples/", "/tests/fixtures/w19/"].some(prefix=>pathname.startsWith(prefix))) return null;
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
  const config = join(temp, "w19-package.config.mts");
  writeFileSync(
    config,
    `import config from ${JSON.stringify(pathToFileURL(join(root, "playwright.config.ts")).href)};export default {...config,testDir:${JSON.stringify(join(root, "tests/playwright"))},testMatch:'w19_style_bundle.spec.ts',outputDir:${JSON.stringify(join(out, "w19-installed-output"))},webServer:undefined,use:{...config.use,baseURL:${JSON.stringify(origin)}},reporter:[['list'],['json',{outputFile:${JSON.stringify(join(out, "w19-installed-playwright.json"))}}]]};`,
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
        "W19 dist",
        "--workers=1",
        "--max-failures=1",
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
  evidence.observe({exitCode:result,servedRoot:installed});
  assert.equal(result, 0, "Installed W19 probes failed");
} finally {
  await new Promise((r) => server.close(r));
}

});
