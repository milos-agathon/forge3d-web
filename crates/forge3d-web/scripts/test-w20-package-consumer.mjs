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
await installedRun({suite:"w20",destination:join(root,"test-results/w20-package-consumer.json"),requiredPhases:["setup","browser","pdf-verification"]}, async evidence => {
const temp = mkdtempSync(join(tmpdir(), "forge3d-w20-consumer-"));
const consumer = join(temp, "consumer");
const artifact = attachInstalledSuite({ packageRoot: root, consumer, suite: "w20" });
const { metadata, tarball, packageSha256 } = artifact;
evidence.artifact(artifact);
run("npm", ["run", "test:api"]);
const installed = join(consumer, "node_modules/@forge3d/web");
for (const file of ['dist/map-plate.js','dist/vector-export.js','dist/vector-pdf.js','dist/colormaps.js','dist/vendor/pdf-lib.js','dist/vendor/fontkit.js','dist/vendor/pdf-lib.LICENSE','dist/vendor/fontkit.LICENSE','dist/vendor/pako.LICENSE','dist/vendor/regenerator-runtime.LICENSE','assets/fonts/DejaVuSans.ttf','assets/fonts/DejaVuSans-Bold.ttf','assets/fonts/DejaVu-LICENSE','types/map-plate.d.ts','types/vector-export.d.ts','types/colormaps.d.ts','docs/cartography.md','examples/cartography.html','dist/forge3d_web_bg.wasm']) assert(statSync(join(installed,file)).size>0,file);
writeFileSync(join(consumer,'consumer.ts'),`import {MapPlate,BBox,Legend,ScaleBar,NorthArrow,ColormapRegistry,colormaps,parseColormapCpt,parseColormapJson,loadColormap,VectorScene,Bounds,exportSvg,exportPdf,type VectorPdfOptions,type MapPlateConfig,type CartographicRenderOptions,type ExportScreenLabel} from '@forge3d/web';
const furnitureOptions:CartographicRenderOptions={signal:new AbortController().signal,maxBytes:1048576}; const labels:ExportScreenLabel[]=[{text:'Projected',screenPosition:[20,30],visible:true}];
const config:MapPlateConfig={width:800,height:600}; const plate=new MapPlate(config),bbox=new BBox(0,0,1,1),cm=colormaps.get('forge3d:viridis');
async function output(){plate.addLegend(await new Legend(cm,[0,1000]).render());plate.addScaleBar(await new ScaleBar(100).render());plate.addNorthArrow(await new NorthArrow().render(furnitureOptions));const png:Blob=await plate.exportPng();const jpeg:Blob=await plate.exportJpeg();const scene=new VectorScene().addLabel('Map',[0,0]);scene.addScreenLabels(labels,100);const svg:Blob=await exportSvg(scene);const opts:VectorPdfOptions={bounds:new Bounds()};const pdf:Blob=await exportPdf(scene,opts);plate.dispose();scene.dispose();return[png,jpeg,svg,pdf];}void output;void bbox;void ColormapRegistry;void parseColormapCpt;void parseColormapJson;void loadColormap;`);
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
console.log(run(process.execPath, [join(root, 'scripts/test-w20-bundled-consumer.mjs'), installed]));
const server = createServer(installedFixtureHandler({
  route(pathname) {
    if (!["/dist/", "/assets/", "/examples/", "/tests/fixtures/w20/"].some(prefix=>pathname.startsWith(prefix))) return null;
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
  const config = join(temp, "w20-package.config.mts");
  writeFileSync(
    config,
    `import config from ${JSON.stringify(pathToFileURL(join(root, "playwright.config.ts")).href)};export default {...config,testDir:${JSON.stringify(join(root, "tests/playwright"))},testMatch:'w20_cartography.spec.ts',outputDir:${JSON.stringify(join(out, "w20-installed-output"))},webServer:undefined,use:{...config.use,baseURL:${JSON.stringify(origin)}},reporter:[['list'],['json',{outputFile:${JSON.stringify(join(out, "w20-installed-playwright.json"))}}]]};`,
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
  evidence.observe({exitCode:result});
  assert.equal(result,0,"Installed W20 browser probes failed");
  evidence.phase("pdf-verification");
  if (result === 0) { const rendered = run('python', [join(root, 'scripts/verify-w20-pdf.py'), join(out, 'w20-installed-playwright.json')]); writeFileSync(join(out,'w20-pdf-render.json'),rendered); console.log(rendered); }
  evidence.observe({exitCode:result,servedRoot:installed,bundledAndCdnWorkflows:48});
  assert.equal(result, 0, "Installed W20 probes failed");
} finally {
  await new Promise((r) => server.close(r));
}

});
