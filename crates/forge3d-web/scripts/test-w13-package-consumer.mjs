import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import {
  join,
  resolve,
  dirname,
  extname,
  relative,
  isAbsolute,
} from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { resolveCommandInvocation } from "./command-executable.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(join(tmpdir(), "forge3d-w13-consumer-")),
  consumer = join(temp, "consumer"),
  pack = join(temp, "pack");
let browser, server;
function run(command, args, cwd = root) {
  const invocation = resolveCommandInvocation(command, args),
    result = spawnSync(invocation.command, invocation.args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    });
  if (result.error || result.status !== 0)
    throw Error(result.error?.message ?? result.stderr + result.stdout);
  return result.stdout;
}
function assert(ok, message) {
  if (!ok) throw Error(message);
}
try {
  run("npm", ["run", "build:ts"]);
  run("npm", ["run", "prepare-dist"]);
  run("npm", ["run", "test:api"]);
  mkdirSync(pack);
  mkdirSync(consumer);
  const packed = JSON.parse(
    run("npm", ["pack", "--json", "--pack-destination", pack]),
  );
  assert(packed.length === 1, "Exactly one tarball expected");
  const tarball = join(pack, packed[0].filename),
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
  const installed = join(consumer, "node_modules", "@forge3d", "web");
  for (const file of [
    "dist/typography.js",
    "dist/labels.js",
    "assets/harfbuzz/harfbuzz.wasm",
    "assets/harfbuzz/LICENSE",
    "assets/fonts/OFL.txt",
    "docs/label-case-contract.json",
  ])
    assert(
      statSync(join(installed, file)).size > 0,
      `Missing packaged ${file}`,
    );
  let html = readFileSync(join(root, "examples/test-w13-labels.html"), "utf8");
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
  const module = script
    .replaceAll(
      "../src-ts/index.ts",
      "/node_modules/@forge3d/web/dist/index.js",
    )
    .replaceAll("../dist/index.js", "/node_modules/@forge3d/web/dist/index.js")
    .replaceAll(
      "../src-ts/viewer.ts",
      "/node_modules/@forge3d/web/dist/viewer.js",
    );
  html = html.replace(
    /<script type="module">[\s\S]*?<\/script>/,
    '<script type="module" src="/acceptance.mjs"></script>',
  );
  writeFileSync(join(consumer, "index.html"), html);
  writeFileSync(join(consumer, "acceptance.mjs"), module);
  writeFileSync(
    join(consumer, "consumer.ts"),
    `import {FontAtlas,LabelLayer,LabelPlan,LabelFeatureSource,LabelStyle,FontFallbackRange,declutterLabels,Forge3DViewer} from '@forge3d/web';
 async function use(canvas:HTMLCanvasElement){const atlas=await FontAtlas.create(),layer=new LabelLayer(atlas);const id=layer.addLabel('A',[0,0,0]).id;new LabelStyle().fontSize=20;new FontFallbackRange('Latin',32,127,'NotoSans');const source=LabelFeatureSource.fromFeatures([{id:'a',geometry:{type:'Point',coordinates:[1,2]},properties:{name:'A'}}]);const plan=source.compileLabels({viewport:[300,200],fontAtlas:atlas});layer.addPlan(LabelPlan.fromJSON(plan.serialize()));const viewer=await Forge3DViewer.create(canvas);viewer.setLabels(layer);viewer.getLabelReport();declutterLabels([{labelId:1,position:[0,0],bounds:[0,0,20,20],priority:1}]);layer.pick(0,0);viewer.dispose();layer.dispose();atlas.dispose();return id;}
`,
  );
  run(
    process.execPath,
    [
      join(root, "node_modules/typescript/bin/tsc"),
      "--noEmit",
      "--strict",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--lib",
      "ES2022,DOM,DOM.Iterable",
      "consumer.ts",
    ],
    consumer,
  );
  const csp =
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'self'; style-src 'self'; img-src 'self' blob:; object-src 'none'";
  server = createServer((req, res) => {
    try {
      const path = resolve(
          consumer,
          "." +
            decodeURIComponent(new URL(req.url, "http://localhost").pathname),
        ),
        rel = relative(consumer, path);
      if (rel.startsWith("..") || isAbsolute(rel))
        throw Error("Path traversal");
      const file = statSync(path).isDirectory()
          ? join(path, "index.html")
          : path,
        data = readFileSync(file),
        mime =
          {
            ".html": "text/html",
            ".mjs": "text/javascript",
            ".js": "text/javascript",
            ".wasm": "application/wasm",
            ".json": "application/json",
            ".ttf": "font/ttf",
          }[extname(file)] ?? "application/octet-stream";
      res.writeHead(200, {
        "content-type": mime,
        "content-security-policy": csp,
        "cache-control": "no-store",
      });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end("Missing");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
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
  await page.goto(origin);
  await page.waitForFunction(() => !!window.__w13);
  const results = {};
  for (const name of [
    "render",
    "outline",
    "depth",
    "session",
    "viewer",
    "contracts",
  ]) {
    results[name] = await page.evaluate((name) => window.__w13[name](), name);
    console.log(`Installed W13 ${name}: verified`);
  }
  const r = results.render;
  assert(
    r.covered > 3000 &&
      r.accepted.length === 4 &&
      r.deterministic &&
      r.replay &&
      r.resizeRoundTrip &&
      r.clearMatches &&
      r.captureDiff.max <= 1,
    "Installed glyph/capture/resize/replay failure",
  );
  assert(
    results.outline.agreement > 0.98 &&
      results.outline.holes > 500 &&
      results.outline.negativeControlAgreement < 0.9,
    "Installed outline/negative control failure",
  );
  assert(
    results.depth.visible > 500 &&
      results.depth.hidden === 0 &&
      results.depth.capture === 0,
    "Installed depth failure",
  );
  assert(
    results.viewer.before > 500 &&
      results.viewer.disabled === 0 &&
      results.viewer.resized > 500 &&
      results.viewer.recovered > 500 &&
      results.viewer.fontStillAlive,
    "Installed viewer lifecycle failure",
  );
  assert(
    results.contracts.nodes > 1 &&
      results.contracts.curved.ok === false &&
      results.contracts.serialized,
    "Installed case contract failure",
  );
  assert(
    !errors.length && !remote.length,
    "Consumer errors or remote dependencies: " +
      JSON.stringify({ errors, remote }),
  );
  // Exercise Vite's emitted asset graph, not only directly served package URLs.
  run(
    process.execPath,
    [
      join(root, "node_modules/vite/bin/vite.js"),
      "build",
      "--base",
      "./",
      "--outDir",
      "build",
    ],
    consumer,
  );
  await page.goto(origin + "/build/");
  await page.waitForFunction(() => !!window.__w13);
  const bundled = await page.evaluate(() => window.__w13.contracts());
  assert(
    bundled.shapingHash === results.render.shapingHash &&
      bundled.glyphCount > 4 &&
      bundled.fonts.length === 3,
    "Bundled HarfBuzz/font graph differs from the installed package",
  );
  assert(
    !errors.length && !remote.length,
    "Bundled consumer errors or remote dependencies: " +
      JSON.stringify({ errors, remote }),
  );
  console.log("Vite-built installed W13 shaping/asset graph: verified");
  const evidence = {
    scope:
      "W13-only installed tarball, Chromium preflight on " + process.platform,
    packageSha256: sha256,
    browser: browser.version(),
    csp,
    remoteRequests: remote,
    pageErrors: errors,
    results,
    bundled,
  };
  mkdirSync(join(root, "test-results"), { recursive: true });
  writeFileSync(
    join(root, "test-results/w13-package-consumer.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log("W13 installed tarball acceptance passed: " + sha256);
} finally {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  if (relative(tmpdir(), temp).startsWith(".."))
    throw Error("Unsafe temporary cleanup");
  rmSync(temp, { recursive: true, force: true });
}
