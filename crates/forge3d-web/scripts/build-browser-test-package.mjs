import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { arch, hostname, platform, release, tmpdir } from "node:os";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import ts from "typescript";

import { validateBrowserEvidence } from "../tests/browser/evidence-validator.mjs";
import {
  exerciseViewerVisibilityLifecycle,
} from "../tests/browser/viewer-visibility-lifecycle.mjs";
import {
  runViewerInteractionObservation,
  VIEWER_INTERACTION_ERROR_KEY,
} from "../tests/browser/viewer-interaction-observation.mjs";
import { resolveCommandInvocation } from "./command-executable.mjs";
import { runEdgeBrowserAcceptance } from "./edge-browser-acceptance.mjs";
import { resolveInstalledTarballBrowserProfile } from "./installed-tarball-browser-profile.mjs";
import { resolvePackageGateMode } from "./package-gate-mode.mjs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = resolve(packageRoot, "..", "..");
const w10Only = process.argv.slice(2).includes("--w10");
const w09Only = process.argv.slice(2).includes("--w09") || w10Only;
if (process.argv.slice(2).some(argument => argument !== "--w09" && argument !== "--w10")) {
  throw new Error("Only --w09 and --w10 are supported; omit it for the full release gate");
}
const evidenceMode = resolvePackageGateMode(
  process.env.FORGE3D_PACKAGE_GATE_MODE,
);
const browserProfile = resolveInstalledTarballBrowserProfile({
  evidenceMode,
  browserChannel: process.env.FORGE3D_BROWSER_CHANNEL,
  operatingSystem: process.platform,
});
const evidenceDirectory = resolve(
  packageRoot,
  process.env.FORGE3D_EVIDENCE_DIR ?? "test-results/browser-gate",
);
assertCleanWorktree(repositoryRoot);
const temporaryRoot = mkdtempSync(join(tmpdir(), "forge3d-web-consumer-"));
const packDirectory = join(temporaryRoot, "pack");
const consumerDirectory = join(temporaryRoot, "consumer");

try {
  run("npm", ["run", "build"], packageRoot);
  if (w09Only) {
    // A portable W09 package acceptance lane. The full release command still
    // requires the infrastructure suite (including POSIX runner/host tests).
    run("npm", ["run", "test:api"], packageRoot);
    run("npm", ["run", "test:release-hardening"], packageRoot);
    run("npm", ["run", "test:browser-harness"], packageRoot);
    run(process.execPath, ["tests/api/package-contract.mjs"], packageRoot);
  } else {
    run("npm", ["run", "test:package"], packageRoot);
  }
  mkdirSync(packDirectory);
  const packResult = JSON.parse(
    run(
      "npm",
      ["pack", "--json", "--pack-destination", packDirectory],
      packageRoot,
      true,
    ),
  );
  if (!Array.isArray(packResult) || packResult.length !== 1) {
    throw new Error("npm pack did not return exactly one package");
  }
  const tarball = resolve(packDirectory, packResult[0].filename);
  const packageSha256 = sha256(readFileSync(tarball));

  mkdirSync(consumerDirectory);
  writeFileSync(
    join(consumerDirectory, "package.json"),
    JSON.stringify(
      {
        name: "forge3d-browser-tarball-consumer",
        private: true,
        type: "module",
        devDependencies: {
          "selenium-webdriver": "4.35.0",
        },
      },
      null,
      2,
    ),
  );
  run("npm", ["install", "--no-save", tarball], consumerDirectory);
  run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      'import { Forge3DViewer, TerrainDataset } from "@forge3d/web"; if (typeof Forge3DViewer !== "function") throw new Error("Forge3DViewer export missing"); if (typeof TerrainDataset !== "function") throw new Error("TerrainDataset export missing");',
    ],
    consumerDirectory,
  );

  const sourceFixture = join(
    packageRoot,
    "examples",
    "test-interactive-viewer.html",
  );
  const consumerFixture = join(consumerDirectory, "test-interactive-viewer.html");
  copyFileSync(sourceFixture, consumerFixture);
  copyFileSync(
    join(packageRoot, "examples", "test-lifecycle-away.html"),
    join(consumerDirectory, "test-lifecycle-away.html"),
  );
  let fixture = readFileSync(consumerFixture, "utf8");
  fixture = fixture.replace(
    '<script type="module">',
    `<script type="importmap">{"imports":{"@forge3d/web":"/node_modules/@forge3d/web/dist/index.js"}}</script>
    <script type="module">`,
  );
  fixture = fixture.replace(
    'from "../src-ts/index.ts"',
    'from "@forge3d/web"',
  );
  fixture = fixture.replace(
    "packageSha256: null",
    `packageSha256: "${packageSha256}"`,
  );
  writeFileSync(consumerFixture, fixture);
  const w03SourceFixture = join(
    packageRoot,
    "examples",
    "test-w03-terrain.html",
  );
  const w03ConsumerFixture = join(consumerDirectory, "test-w03-terrain.html");
  let w03Fixture = readFileSync(w03SourceFixture, "utf8");
  w03Fixture = w03Fixture.replace(
    '<script type="module">',
    `<script type="importmap">{"imports":{"@forge3d/web":"/node_modules/@forge3d/web/dist/index.js"}}</script>
    <script type="module">`,
  );
  w03Fixture = w03Fixture.replace(
    'from "../src-ts/index.ts"',
    'from "@forge3d/web"',
  );
  w03Fixture = w03Fixture.replace(
    "packageSha256 = null",
    `packageSha256 = "${packageSha256}"`,
  );
  writeFileSync(w03ConsumerFixture, w03Fixture);
  const w04ConsumerFixture = join(consumerDirectory, "test-w04-package.html");
  let w04Fixture = readFileSync(
    join(packageRoot, "examples", "test-w04-package.html"),
    "utf8",
  );
  w04Fixture = w04Fixture.replace(
    '<script type="module">',
    `<script type="importmap">{"imports":{"@forge3d/web":"/node_modules/@forge3d/web/dist/index.js"}}</script>
    <script type="module">`,
  );
  w04Fixture = w04Fixture.replace(
    'from "../src-ts/index.ts"',
    'from "@forge3d/web"',
  );
  w04Fixture = w04Fixture.replace(
    'new URL("../src-ts/index.ts", import.meta.url).href',
    'new URL("/node_modules/@forge3d/web/dist/index.js", import.meta.url).href',
  );
  w04Fixture = w04Fixture.replace(
    "packageSha256 = null",
    `packageSha256 = "${packageSha256}"`,
  );
  writeFileSync(w04ConsumerFixture, w04Fixture);
  const w05ConsumerFixture = join(consumerDirectory, "test-w05-package.html");
  let w05Fixture = readFileSync(
    join(packageRoot, "examples", "test-w05-package.html"),
    "utf8",
  );
  w05Fixture = w05Fixture.replace(
    '<script type="module">',
    `<script type="importmap">{"imports":{"@forge3d/web":"/node_modules/@forge3d/web/dist/index.js"}}</script>
    <script type="module">`,
  );
  w05Fixture = w05Fixture.replace(
    'from "../src-ts/index.ts"',
    'from "@forge3d/web"',
  );
  w05Fixture = w05Fixture.replace(
    "packageSha256 = null",
    `packageSha256 = "${packageSha256}"`,
  );
  writeFileSync(w05ConsumerFixture, w05Fixture);
  const w06ConsumerFixture = join(consumerDirectory, "test-w06-package.html");
  let w06Fixture = readFileSync(
    join(packageRoot, "examples", "test-w06-package.html"),
    "utf8",
  );
  w06Fixture = w06Fixture.replace(
    '<script type="module">',
    `<script type="importmap">{"imports":{"@forge3d/web":"/node_modules/@forge3d/web/dist/index.js"}}</script>
    <script type="module">`,
  );
  w06Fixture = w06Fixture.replace(
    'from "../src-ts/index.ts"',
    'from "@forge3d/web"',
  );
  w06Fixture = w06Fixture.replace(
    "packageSha256 = null",
    `packageSha256 = "${packageSha256}"`,
  );
  writeFileSync(w06ConsumerFixture, w06Fixture);
  const w07ConsumerFixture = join(consumerDirectory, "test-w07-package.html");
  let w07Fixture = readFileSync(
    join(packageRoot, "examples", "test-w07-package.html"),
    "utf8",
  );
  w07Fixture = w07Fixture.replace(
    '<script type="module">',
    `<script type="importmap">{"imports":{"@forge3d/web":"/node_modules/@forge3d/web/dist/index.js"}}</script>
    <script type="module">`,
  );
  w07Fixture = w07Fixture.replace(
    'from "../src-ts/index.ts"',
    'from "@forge3d/web"',
  );
  w07Fixture = w07Fixture.replace(
    "packageSha256 = null",
    `packageSha256 = "${packageSha256}"`,
  );
  writeFileSync(w07ConsumerFixture, w07Fixture);
  const w08ConsumerFixture = join(consumerDirectory, "test-w08-package.html");
  let w08Fixture = readFileSync(
    join(packageRoot, "examples", "test-w08-package.html"),
    "utf8",
  );
  w08Fixture = w08Fixture.replace(
    '<script type="module">',
    `<script type="importmap">{"imports":{"@forge3d/web":"/node_modules/@forge3d/web/dist/index.js"}}</script>
    <script type="module">`,
  );
  w08Fixture = w08Fixture.replace(
    'from "../src-ts/index.ts"',
    'from "@forge3d/web"',
  );
  w08Fixture = w08Fixture.replace(
    "packageSha256 = null",
    `packageSha256 = "${packageSha256}"`,
  );
  writeFileSync(w08ConsumerFixture, w08Fixture);
  // COG decode worker: in the consumer it imports the packaged dist module
  // (worker-src 'self'), which in turn loads the vendored geotiff bundle.
  const w08WorkerFixture = join(consumerDirectory, "test-w08-cog-worker.js");
  let w08Worker = readFileSync(
    join(packageRoot, "examples", "test-w08-cog-worker.js"),
    "utf8",
  );
  w08Worker = w08Worker.replace(
    'from "../src-ts/index.ts"',
    'from "/node_modules/@forge3d/web/dist/index.js"',
  );
  writeFileSync(w08WorkerFixture, w08Worker);
  const w08FixtureDirectory = join(consumerDirectory, "fixtures", "w08");
  mkdirSync(w08FixtureDirectory, { recursive: true });
  copyFileSync(
    join(
      packageRoot,
      "tests",
      "golden",
      "w08",
      "predictor-deflate-u16.tif",
    ),
    join(w08FixtureDirectory, "predictor-deflate-u16.tif"),
  );
  const w09Fixture = readFileSync(join(packageRoot, "examples", "test-w09.html"), "utf8")
    .replace('const api = new URLSearchParams(location.search).has("dist") ? await import("../dist/index.js") : await import("../src-ts/index.ts");', 'const api = await import("/node_modules/@forge3d/web/dist/index.js");');
  writeFileSync(join(consumerDirectory, "test-w09.html"), w09Fixture);
  writeFileSync(join(consumerDirectory, "test-w09-worker.js"), readFileSync(join(packageRoot, "examples", "test-w09-worker.js"), "utf8").replace('../src-ts/index.ts', '/node_modules/@forge3d/web/dist/index.js'));
  const w09GoldenDirectory = join(consumerDirectory, "tests", "golden", "w09");
  mkdirSync(w09GoldenDirectory, {recursive:true});
  copyFileSync(join(packageRoot, "tests", "golden", "w09", "probes.json"), join(w09GoldenDirectory, "probes.json"));
  const w10Fixture = readFileSync(join(packageRoot, "examples", "test-w10.html"), "utf8")
    .replace(/const api\s*=[\s\S]*?;\n/, 'const api=await import("/node_modules/@forge3d/web/dist/index.js");\n')
    .replace("../src-ts/viewer.ts", "/node_modules/@forge3d/web/dist/viewer.js");
  writeFileSync(join(consumerDirectory, "test-w10.html"), w10Fixture);
  copyFileSync(join(packageRoot,"examples","w10-acceptance.js"),join(consumerDirectory,"w10-acceptance.js"));
  writeFileSync(join(consumerDirectory,"test-w10-native.html"),readFileSync(join(packageRoot,"examples","test-w07-materials.html"),"utf8")
    .replaceAll("../src-ts/index.ts","/node_modules/@forge3d/web/dist/index.js")
    .replaceAll("../src-ts/session.ts","/node_modules/@forge3d/web/dist/session.js")
    .replaceAll("../src-ts/runtime-internals.ts","/node_modules/@forge3d/web/dist/runtime-internals.js"));

  copyFileSync(join(packageRoot, "examples", "w10-native-probes.js"), join(consumerDirectory, "w10-native-probes.js"));
  writeFileSync(join(consumerDirectory, "test-w10-worker.js"), readFileSync(join(packageRoot, "examples", "test-w10-worker.js"), "utf8").replace("../src-ts/index.ts", "/node_modules/@forge3d/web/dist/index.js"));
  cpSync(join(packageRoot, "tests", "golden", "w10"), join(consumerDirectory, "tests", "golden", "w10"), {recursive:true});
  for (const name of ["sky", "effects"]) copyFileSync(join(packageRoot, "src", "runtime", "environment", `${name}.wgsl`), join(consumerDirectory, `w10-runtime-${name}.wgsl`));
  const benchmarkDirectory = join(
    consumerDirectory,
    "tests",
    "browser",
    "benchmark",
  );
  mkdirSync(benchmarkDirectory, { recursive: true });
  for (const file of [
    "benchmark-manifest-v1.json",
    "benchmark-terrain-v1.f32le",
    "benchmark-trace-v1.json",
  ]) {
    copyFileSync(
      join(packageRoot, "tests", "browser", "benchmark", file),
      join(benchmarkDirectory, file),
    );
  }
  const benchmarkModulePath = join(temporaryRoot, "viewer-benchmark.mjs");
  copyFileSync(
    join(packageRoot, "tests", "browser", "viewer-benchmark-browser.js"),
    join(temporaryRoot, "viewer-benchmark-browser.js"),
  );
  writeFileSync(
    benchmarkModulePath,
    ts.transpileModule(
      readFileSync(
        join(packageRoot, "tests", "browser", "viewer-benchmark.ts"),
        "utf8",
      ),
      {
        compilerOptions: {
          module: ts.ModuleKind.ES2022,
          target: ts.ScriptTarget.ES2022,
        },
      },
    ).outputText,
  );
  const { runViewerBenchmark } = await import(
    pathToFileURL(benchmarkModulePath).href
  );
  const commit = run("git", ["rev-parse", "HEAD"], repositoryRoot, true).trim();
  const packageEvidence = {
    commit,
    tarball: basename(tarball),
    packageSha256,
    fixture: "test-interactive-viewer.html",
    evidenceMode,
    gateScope: w10Only ? "w10-package-acceptance" : w09Only ? "w09-package-acceptance" : "full-release",
  };
  writeFileSync(
    join(consumerDirectory, "package-evidence.json"),
    JSON.stringify(packageEvidence, null, 2),
  );

  const server = createStaticServer(consumerDirectory);
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("consumer fixture server did not expose a TCP port");
    }
    const origin = `http://127.0.0.1:${address.port}`;
    const [htmlResponse, moduleResponse, wasmResponse] = await Promise.all([
      fetch(`${origin}/test-interactive-viewer.html`),
      fetch(`${origin}/node_modules/@forge3d/web/dist/index.js`),
      fetch(`${origin}/node_modules/@forge3d/web/dist/forge3d_web_bg.wasm`),
    ]);
    if (!htmlResponse.ok || !moduleResponse.ok || !wasmResponse.ok) {
      throw new Error("installed tarball fixture or package assets were not served");
    }
    if (
      wasmResponse.headers.get("content-type")?.split(";", 1)[0] !==
      "application/wasm"
    ) {
      throw new Error("consumer server did not serve WASM as application/wasm");
    }
    const servedFixture = await htmlResponse.text();
    if (
      !servedFixture.includes('from "@forge3d/web"') ||
      !servedFixture.includes(packageSha256)
    ) {
      throw new Error("served fixture did not import the tarball or record its hash");
    }
    const browserResult = await runInstalledPackageBrowserGate(
      origin,
      packageSha256,
      commit,
      runViewerBenchmark,
      browserProfile,
    );
    browserResult.gateScope = w10Only ? "w10-package-acceptance" : w09Only ? "w09-package-acceptance" : "full-release";
    const browserEvidenceJson = JSON.stringify(browserResult, null, 2);
    writeFileSync(join(consumerDirectory, "browser-gate.json"), browserEvidenceJson);
    mkdirSync(evidenceDirectory, { recursive: true });
    writeFileSync(join(evidenceDirectory, "browser-gate.json"), browserEvidenceJson);
    writeFileSync(
      join(evidenceDirectory, "package-evidence.json"),
      JSON.stringify(packageEvidence, null, 2),
    );
    copyFileSync(tarball, join(evidenceDirectory, basename(tarball)));
    const retainedFixture = join(evidenceDirectory, "consumer-fixture");
    mkdirSync(retainedFixture, { recursive: true });
    for (const file of [
      "package.json",
      "package-evidence.json",
      "test-interactive-viewer.html",
      "test-lifecycle-away.html",
      "test-w03-terrain.html",
      "test-w04-package.html",
      "test-w05-package.html",
      "test-w06-package.html",
      "test-w07-package.html",
      "test-w08-package.html",
      "test-w08-cog-worker.js",
      ...(w10Only ? ["test-w10.html", "test-w10-native.html", "w10-acceptance.js", "test-w10-worker.js", "w10-native-probes.js", "w10-runtime-sky.wgsl", "w10-runtime-effects.wgsl"] : []),
    ]) {
      copyFileSync(join(consumerDirectory, file), join(retainedFixture, file));
    }
    cpSync(
      join(consumerDirectory, "tests"),
      join(retainedFixture, "tests"),
      { recursive: true, force: false },
    );
    writeFileSync(
      join(retainedFixture, "tests", "browser", "adapter-attestation.js"),
      ts.transpileModule(
        readFileSync(
          join(packageRoot, "tests", "browser", "adapter-attestation.ts"),
          "utf8",
        ),
        {
          compilerOptions: {
            module: ts.ModuleKind.ES2022,
            target: ts.ScriptTarget.ES2022,
          },
        },
      ).outputText,
    );
    copyFileSync(
      join(packageRoot, "tests", "browser", "hardware-page-harness.js"),
      join(retainedFixture, "tests", "browser", "hardware-page-harness.js"),
    );
    mkdirSync(join(retainedFixture, "tests", "webdriver"), { recursive: true });
    copyFileSync(
      join(packageRoot, "tests", "webdriver", "safari-viewer.mjs"),
      join(retainedFixture, "tests", "webdriver", "safari-viewer.mjs"),
    );
    copyFileSync(
      join(packageRoot, "tests", "browser", "saf02-conformance.js"),
      join(retainedFixture, "tests", "browser", "saf02-conformance.js"),
    );
    copyFileSync(
      join(packageRoot, "tests", "browser", "viewer-benchmark-browser.js"),
      join(retainedFixture, "tests", "browser", "viewer-benchmark-browser.js"),
    );
    copyFileSync(
      join(packageRoot, "tests", "browser", "viewer-bfcache-lifecycle.js"),
      join(retainedFixture, "tests", "browser", "viewer-bfcache-lifecycle.js"),
    );
    copyFileSync(
      join(packageRoot, "scripts", "chr03-lanes.mjs"),
      join(retainedFixture, "tests", "browser", "chr03-lanes.js"),
    );
    copyFileSync(
      join(packageRoot, "scripts", "chr04-lanes.mjs"),
      join(retainedFixture, "tests", "browser", "chr04-lanes.js"),
    );
    copyFileSync(
      join(packageRoot, "scripts", "ffx03-lanes.mjs"),
      join(retainedFixture, "tests", "browser", "ffx03-lanes.js"),
    );
    copyFileSync(
      benchmarkModulePath,
      join(retainedFixture, "viewer-benchmark.mjs"),
    );
    mkdirSync(join(retainedFixture, "hardware"), { recursive: true });
    copyFileSync(
      join(packageRoot, "tests", "hardware", "run-browser-lane.mjs"),
      join(retainedFixture, "hardware", "run-browser-lane.mjs"),
    );
  } finally {
    await new Promise((resolvePromise, reject) =>
      server.close((error) => (error ? reject(error) : resolvePromise())),
    );
  }

  console.log(
    JSON.stringify(
      {
        package: "@forge3d/web",
        tarball: basename(tarball),
        packageSha256,
        installedFromAbsoluteTarball: true,
        fixtureServedFromConsumer: true,
        browserGatePassed: true,
        evidenceMode,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

async function runInstalledPackageBrowserGate(
  origin,
  packageSha256,
  commit,
  runViewerBenchmark,
  browserProfile,
) {
  const browser = await chromium.launch({
    ...(browserProfile.playwrightChannel === null
      ? {}
      : { channel: browserProfile.playwrightChannel }),
    headless: process.env.FORGE3D_HEADED !== "1",
    args: browserProfile.launchArguments,
  });
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  try {
    await page.goto(`${origin}/test-interactive-viewer.html`, {
      waitUntil: "networkidle",
    });
    const adapter = await page.evaluate(async () => {
      const gpuAdapter = await navigator.gpu?.requestAdapter();
      if (!gpuAdapter) {
        return {
          available: false,
          fallback: null,
          identity: null,
          limits: {},
        };
      }
      const info = gpuAdapter.info;
      const directFallback = gpuAdapter.isFallbackAdapter;
      const fallback =
        typeof directFallback === "boolean"
          ? directFallback
          : typeof info?.isFallbackAdapter === "boolean"
            ? info.isFallbackAdapter
            : null;
      const identity = [
        info?.vendor,
        info?.architecture,
        info?.device,
        info?.description,
      ]
        .filter(Boolean)
        .join(" / ");
      return {
        available: true,
        fallback,
        identity: identity || null,
        limits: {
          maxTextureDimension2D: gpuAdapter.limits.maxTextureDimension2D,
          maxBufferSize: gpuAdapter.limits.maxBufferSize,
        },
      };
    });
    if (!adapter.available) {
      throw new Error("installed-package browser gate found no WebGPU adapter");
    }
    if (browserProfile.lane === "required" && adapter.fallback !== false) {
      throw new Error("installed-package browser gate used a fallback adapter");
    }

    const initial = await page.evaluate(async (errorKey) => {
      window[errorKey] = [];
      const viewer = await window.__forge3dInteractiveViewer.create({
        onError(error) {
          window[errorKey]?.push(
            typeof error?.code === "string"
              ? error.code
              : "INTERNAL_ERROR",
          );
        },
      });
      return {
        view: viewer.getView(),
        diagnostics: viewer.getDiagnostics(),
        packageSha256: window.__forge3dInteractiveViewer.packageSha256,
      };
    }, VIEWER_INTERACTION_ERROR_KEY);
    if (initial.packageSha256 !== packageSha256) {
      throw new Error("browser fixture did not execute the expected tarball");
    }

    const canvas = page.locator("#viewer");
    const box = await canvas.boundingBox();
    if (!box) {
      throw new Error("installed-package canvas has no browser layout box");
    }
    await page.mouse.move(box.x + 160, box.y + 160);
    await page.mouse.down();
    await page.mouse.move(box.x + 205, box.y + 135, { steps: 4 });
    await page.mouse.up();
    const afterMouse = await page.evaluate(() =>
      window.__forge3dInteractiveViewer.viewer.getView(),
    );
    await page.mouse.wheel(0, -120);
    const afterWheel = await page.evaluate(() =>
      window.__forge3dInteractiveViewer.viewer.getView(),
    );
    await canvas.focus();
    await page.keyboard.press("ArrowRight");
    const afterKeyboard = await page.evaluate(() =>
      window.__forge3dInteractiveViewer.viewer.getView(),
    );
    const interactionAssertions = {
      mouse: JSON.stringify(afterMouse) !== JSON.stringify(initial.view),
      wheel: JSON.stringify(afterWheel) !== JSON.stringify(afterMouse),
      keyboard: JSON.stringify(afterKeyboard) !== JSON.stringify(afterWheel),
      touch: false,
      resize: false,
      disposal: false,
    };
    const visibilityLifecycle =
      await exerciseViewerVisibilityLifecycle({
        page,
        context: page.context(),
        requireActualDocumentVisibilityTransitions:
          process.env.FORGE3D_HEADED === "1",
      });
    const interactionObservation =
      await runViewerInteractionObservation(page);

    const result = await page.evaluate(async () => {
      const viewer = window.__forge3dInteractiveViewer.viewer;
      const viewAfterInteractions = viewer.getView();
      const firstScreenshot = await viewer.screenshot();
      viewer.resize({ width: 240, height: 180, devicePixelRatio: 2 });
      const secondScreenshot = await viewer.screenshot();
      const sizeAfterResize = {
        width: window.__forge3dInteractiveViewer.canvas.width,
        height: window.__forge3dInteractiveViewer.canvas.height,
      };
      viewer.dispose();
      return {
        viewAfterInteractions,
        firstScreenshot: {
          type: firstScreenshot.type,
          size: firstScreenshot.size,
        },
        secondScreenshot: {
          type: secondScreenshot.type,
          size: secondScreenshot.size,
        },
        sizeAfterResize,
        status: viewer.status,
        diagnostics: viewer.getDiagnostics(),
      };
    });

    if (JSON.stringify(result.viewAfterInteractions) === JSON.stringify(initial.view)) {
      throw new Error("installed-package browser interactions did not change the view");
    }
    for (const screenshot of [result.firstScreenshot, result.secondScreenshot]) {
      if (screenshot.type !== "image/png" || screenshot.size <= 0) {
        throw new Error("installed-package screenshot was not a non-empty PNG");
      }
    }
    if (
      result.sizeAfterResize.width !== 480 ||
      result.sizeAfterResize.height !== 360
    ) {
      throw new Error("installed-package resize did not update backing dimensions");
    }
    interactionAssertions.resize = true;
    if (
      result.status !== "disposed" ||
      result.diagnostics.ownedListeners !== 0 ||
      result.diagnostics.activeObservers !== 0 ||
      result.diagnostics.activePointers !== 0 ||
      result.diagnostics.activeRuntimes !== 0 ||
      result.diagnostics.pendingAnimationFrame
    ) {
      throw new Error("installed-package disposal leaked viewer resources");
    }
    interactionAssertions.disposal = true;
    if (pageErrors.length > 0) {
      throw new Error(`installed-package page errors: ${pageErrors.join("; ")}`);
    }
    const benchmark =
      browserProfile.lane === "required"
        ? await runViewerBenchmark(page, {
            browserZoom: 1,
            thermalState: "unavailable",
            thermalSignalProvenance: "browser API unavailable",
            lowPowerMode: "unavailable",
            lowPowerSignalProvenance: "browser API unavailable",
          })
        : null;
    const edgeAcceptance = await runEdgeBrowserAcceptance({
      browser,
      page,
      fixtureUrl: `${origin}/test-interactive-viewer.html`,
    });
    interactionAssertions.touch = edgeAcceptance.touch.viewChanged === true &&
      edgeAcceptance.touch.activePointersAfter === 0 && edgeAcceptance.touch.disposed === true;
    for (const [name, passed] of Object.entries(interactionAssertions)) {
      if (!passed) {
        throw new Error(
          `installed-package ${name} interaction did not independently satisfy its assertion`,
        );
      }
    }
    const frameCounters = await page.evaluate(() =>
      window.__forge3dInteractiveViewer.viewer.getDiagnostics(),
    );
    const browserEnvironment = await page.evaluate(() => ({
      secureContext: window.isSecureContext,
      userAgent: navigator.userAgent,
    }));
    const evidence = {
      schemaVersion: 3,
      sourceRevision: {
        commit,
        worktreeClean: true,
      },
      artifact: {
        kind: "npm-tarball",
        sha256: packageSha256,
      },
      project: browserProfile.project,
      lane: browserProfile.lane,
      browser: {
        name: browserProfile.browserName,
        version: browser.version(),
        channel: browserProfile.browserChannel,
        userAgent: browserEnvironment.userAgent,
      },
      os: {
        name: platform(),
        version: release(),
        build: release(),
      },
      architecture: arch(),
      deviceId: hostname(),
      headed: process.env.FORGE3D_HEADED === "1",
      secureContext: browserEnvironment.secureContext,
      launchArguments: [...browserProfile.launchArguments],
      adapter,
      runtimeResult: browserProfile.runtimeResult,
      frameCounters: {
        renderRequests: frameCounters.renderRequests,
        submittedFrames: frameCounters.submittedFrames,
        skippedFrames: frameCounters.skippedFrames,
      },
      interactionAssertions,
      normalizedErrorCodes:
        interactionObservation.normalizedErrorCodes,
      benchmark,
    };
    if (browserProfile.lane === "required") {
      validateBrowserEvidence(evidence);
    } else {
      validateBrowserEvidence(evidence, {
        requireBenchmark: false,
        requireReleaseArtifact: true,
      });
    }
    await page.goto(`${origin}/test-w03-terrain.html`, {
      waitUntil: "networkidle",
    });
    const terrainDataset = await page.evaluate(() =>
      window.__forge3dW03Probe(),
    );
    if (terrainDataset.supported !== true || terrainDataset.ok !== true) {
      throw new Error(
        `installed-package terrain dataset probe failed: ${JSON.stringify(terrainDataset.error ?? terrainDataset)}`,
      );
    }
    if (terrainDataset.packageSha256 !== packageSha256) {
      throw new Error(
        "installed-package terrain fixture did not execute the expected tarball",
      );
    }
    for (const mode of ["direct", "file", "url"]) {
      const sourceResult = terrainDataset.sources?.[mode];
      if (
        !sourceResult ||
        sourceResult.maxError > 1e-6 ||
        sourceResult.nanMismatch !== 0
      ) {
        throw new Error(
          `installed-package terrain dataset ${mode} source mode failed: ${JSON.stringify(sourceResult)}`,
        );
      }
    }
    await page.goto(`${origin}/test-w04-package.html`, {
      waitUntil: "networkidle",
    });
    const w04Package = await page.evaluate(() =>
      window.__forge3dW04PackageProbe(),
    );
    if (w04Package.supported !== true || w04Package.ok !== true) {
      throw new Error(
        `installed-package W04 probe failed: ${JSON.stringify(w04Package.error ?? w04Package)}`,
      );
    }
    if (w04Package.packageSha256 !== packageSha256) {
      throw new Error(
        "installed-package W04 fixture did not execute the expected tarball",
      );
    }
    if (
      w04Package.shadow?.effectiveFilter !== "pcf" ||
      w04Package.shadow?.cascadeCount !== 2 ||
      w04Package.disabledShadow?.csmEnabled !== false ||
      w04Package.ibl?.effectiveMode !== "prepared-upload" ||
      w04Package.csmRejection?.code !== "INVALID_INPUT" ||
      w04Package.basisAsset?.status !== 200 ||
      !(w04Package.basisAsset?.bytes > 0) ||
      !(w04Package.lightingChange > 0.1)
    ) {
      throw new Error(
        `installed-package W04 lighting/material/IBL/shadow surface failed: ${JSON.stringify(w04Package)}`,
      );
    }
    await page.goto(`${origin}/test-w05-package.html`, {
      waitUntil: "networkidle",
    });
    const w05Package = await page.evaluate(() =>
      window.__forge3dW05PackageProbe(),
    );
    if (w05Package.supported !== true || w05Package.ok !== true) {
      throw new Error(
        `installed-package W05 probe failed: ${JSON.stringify(w05Package.error ?? w05Package)}`,
      );
    }
    if (w05Package.packageSha256 !== packageSha256) {
      throw new Error(
        "installed-package W05 fixture did not execute the expected tarball",
      );
    }
    if (
      !(w05Package.projection?.orthographicCovered > 1000) ||
      !(w05Package.projection?.projectionDiffers > 1) ||
      !(w05Package.projection?.orthographicDistanceChange < 0.01) ||
      w05Package.animation?.frames !== 61 ||
      !(w05Package.rig?.minClearance >= 2 - 1e-9) ||
      w05Package.replay?.equal !== true ||
      w05Package.orthographicRejection !== "INVALID_INPUT"
    ) {
      throw new Error(
        `installed-package W05 camera/animation/rig surface failed: ${JSON.stringify(w05Package)}`,
      );
    }
    await page.goto(`${origin}/test-w06-package.html`, {
      waitUntil: "networkidle",
    });
    const w06Package = await page.evaluate(() =>
      window.__forge3dW06PackageProbe(),
    );
    if (w06Package.supported !== true || w06Package.ok !== true) {
      throw new Error(
        `installed-package W06 probe failed: ${JSON.stringify(w06Package.error ?? w06Package)}`,
      );
    }
    if (w06Package.packageSha256 !== packageSha256) {
      throw new Error(
        "installed-package W06 fixture did not execute the expected tarball",
      );
    }
    if (
      !(w06Package.capture?.hdrError <= 1e-5) ||
      w06Package.capture?.id !== true ||
      w06Package.offline?.samplesUsed !== 4 ||
      w06Package.offline?.denoiser !== "atrous" ||
      w06Package.exr?.channels !== 14 ||
      w06Package.exr?.mse !== 0 ||
      w06Package.frames?.count !== 6 ||
      (w06Package.video?.ok !== true &&
        w06Package.video?.kind !== "video-codec-unavailable")
    ) {
      throw new Error(
        `installed-package W06 capture/offline/EXR/frame/video surface failed: ${JSON.stringify(w06Package)}`,
      );
    }
    await page.goto(`${origin}/test-w07-package.html`, {
      waitUntil: "networkidle",
    });
    const w07Package = await page.evaluate(() =>
      window.__forge3dW07PackageProbe(),
    );
    if (w07Package.supported !== true || w07Package.ok !== true) {
      throw new Error(
        `installed-package W07 probe failed: ${JSON.stringify(w07Package.error ?? w07Package)}`,
      );
    }
    if (w07Package.packageSha256 !== packageSha256) {
      throw new Error(
        "installed-package W07 fixture did not execute the expected tarball",
      );
    }
    if (
      w07Package.defaults?.albedoMode !== "colormap" ||
      w07Package.rejection !== "INVALID_INPUT" ||
      !(w07Package.zeroMaxDiff <= 1) ||
      !(w07Package.fullDelta > 1) ||
      w07Package.report?.enabled !== true ||
      w07Package.report?.layerCount !== 2 ||
      w07Package.report?.maskChannels?.[0] !== "wetness"
    ) {
      throw new Error(
        `installed-package W07 terrain material surface failed: ${JSON.stringify(w07Package)}`,
      );
    }
    // The packaged dist must resolve geotiff only through the vendored
    // bundle — a bare "geotiff" specifier would fail for consumers.
    const distCogResponse = await fetch(
      `${origin}/node_modules/@forge3d/web/dist/cog.js`,
    );
    if (!distCogResponse.ok) {
      throw new Error("installed-package dist cog.js was not served");
    }
    const distCogSource = await distCogResponse.text();
    if (
      /(?:from|import)\s*[(]?\s*["']geotiff["']/.test(distCogSource) ||
      distCogSource.includes('import("geotiff")') ||
      distCogSource.includes("import('geotiff')")
    ) {
      throw new Error(
        "installed-package dist cog.js retains a bare geotiff specifier",
      );
    }
    await page.goto(`${origin}/test-w08-package.html`, {
      waitUntil: "networkidle",
    });
    const w08Package = await page.evaluate(async (fixtureUrl) => {
      await new Promise((resolve) => {
        const poll = () =>
          window.__forge3dW08PackageProbe === undefined
            ? setTimeout(poll, 25)
            : resolve();
        poll();
      });
      return window.__forge3dW08PackageProbe(fixtureUrl);
    }, `${origin}/fixtures/w08/predictor-deflate-u16.tif`);
    if (w08Package.supported !== true || w08Package.ok !== true) {
      throw new Error(
        `installed-package W08 probe failed: ${JSON.stringify(w08Package.error ?? w08Package)}`,
      );
    }
    if (w08Package.packageSha256 !== packageSha256) {
      throw new Error(
        "installed-package W08 fixture did not execute the expected tarball",
      );
    }
    // The vendored geotiff must decode the predictor tile exactly on the
    // main thread and in the packaged module worker, and the clipmap must
    // render at its triangle budget.
    if (
      w08Package.mainThread?.sha256 !==
        "18e1b10ecc37597db28376dd9a533ccb6a03c075d7a3b4e448be562abff740fb" ||
      w08Package.decodeParity !== true ||
      w08Package.worker?.mode === "main-thread" ||
      w08Package.render?.geometry?.triangleCount !==
        w08Package.render?.geometry?.triangleBudget ||
      !(w08Package.render?.nonClearPixels > 0)
    ) {
      throw new Error(
        `installed-package W08 decode/render contract failed: ${JSON.stringify({
          mainThread: w08Package.mainThread,
          decodeParity: w08Package.decodeParity,
          worker: w08Package.worker,
          geometry: w08Package.render?.geometry,
        })}`,
      );
    }
    if (
      w08Package.mainThread?.sha256 !==
        "18e1b10ecc37597db28376dd9a533ccb6a03c075d7a3b4e448be562abff740fb" ||
      w08Package.decodeParity !== true ||
      w08Package.worker?.mode === "main-thread" ||
      w08Package.render?.nonClearPixels <= 0 ||
      w08Package.render?.geometry?.mode !== "clipmap" ||
      w08Package.render?.geometry?.triangleCount !==
        w08Package.render?.geometry?.triangleBudget ||
      w08Package.render?.overlays?.enabled !== true ||
      w08Package.render?.overlays?.layerCount !== 1 ||
      w08Package.render?.vt === null ||
      w08Package.render?.vt === undefined
    ) {
      throw new Error(
        `installed-package W08 COG/clipmap/overlay/VT surface failed: ${JSON.stringify(w08Package)}`,
      );
    }
    await page.goto(`${origin}/test-w09.html`, {waitUntil:"networkidle"});
    await page.waitForFunction(()=>window.__w09!==undefined);
    const w09Package = await page.evaluate(async()=>({render:await window.__w09.render(),scene:await window.__w09.scene(),native:await window.__w09.native(),worker:await window.__w09.worker(),hlodPixels:await window.__w09.hlodPixels(),probeBehavior:await window.__w09.probeBehavior(),cancelBake:await window.__w09.cancelBake(),ridge:await window.__w09.irradiance(1),budgets:await window.__w09.budgets(),irradiance:await window.__w09.irradiance(),reflections:await window.__w09.reflections()}));
    const w09=w09Package.render;
    if (!(w09.scatterDelta>.2 && w09.windDelta>.05 && w09.stats.visibleInstances===2 && w09.scatterIds.length===2 && w09.bakeExact && w09.reflectionExact && w09.zeroHash===w09.noProbeHash && w09.baselineHash===w09.clearedHash && w09.hlod.hlodCoveredInstances===2 && w09Package.scene.ids.length===2 && w09Package.worker.nonempty && w09Package.worker.hash!==w09Package.worker.staticHash && w09Package.worker.hash!==w09Package.worker.timeHash && w09Package.scene.hash!==w09Package.scene.timeHash && w09Package.hlodPixels.a===w09Package.hlodPixels.b && w09Package.hlodPixels.a===w09Package.hlodPixels.static && w09Package.hlodPixels.ids.length===1 && w09Package.probeBehavior.outside===0 && w09Package.probeBehavior.center>w09Package.probeBehavior.edge && w09Package.probeBehavior.edge>0 && w09Package.probeBehavior.stressCount===64 && w09Package.probeBehavior.rejected && w09Package.probeBehavior.before===w09Package.probeBehavior.after && w09Package.probeBehavior.cleared!==w09Package.probeBehavior.before && w09Package.cancelBake.responsive && w09Package.cancelBake.code==="REQUEST_CANCELLED" && w09Package.native.every(c=>c.maxAbs<=1e-3 && c.ssim>=.98 && c.controlSsim<.98) && w09Package.irradiance.maxAbs<=1e-3 && w09Package.irradiance.ssim>=.98 && w09Package.ridge.maxAbs<=1e-3 && w09Package.ridge.ssim>=.98 && w09Package.ridge.normalDirections>1 && w09Package.ridge.center<w09Package.ridge.flatNativeUp && w09Package.reflections.count===18*1024 && w09Package.reflections.faces.length===6 && w09Package.reflections.maxAbs<=1e-3 && w09Package.reflections.ssim>=.98 && w09Package.budgets.failures.length===3 && w09Package.budgets.before===w09Package.budgets.after)) {
      throw new Error(`installed-package W09 contract failed: ${JSON.stringify(w09Package)}`);
    }
    await page.goto(`${origin}/test-w10.html`, {waitUntil:"networkidle"});
    await page.waitForFunction(()=>window.__w10!==undefined);
    const w10Package = await page.evaluate(async()=>({render:await window.__w10.render(),bounds:await window.__w10.bounds(),masks:await window.__w10.masks(),budget:await window.__w10.budget(),offline:await window.__w10.offline(),recovery:await window.__w10.recovery(),quality:await window.__w10.quality(),native:await window.__w10.native(),worker:await window.__w10.worker(),downscale:await window.__w10.downscale(),cloudsAndWaves:await window.__w10.cloudsAndWaves(),goldens:await window.__w10.goldens(),restoreLights:await window.__w10.restoreLights(),aerial:await window.__w10.aerial(),waterControls:await window.__w10.waterControls(),preservation:await window.__w10.preservation(),volumeTemporal:await (async()=>{const c=await(await fetch("/tests/golden/w10/volume-temporal-v1.json")).json();return window.__w10.bounds(c.width,c.height,c);})()}));
    const e=w10Package;
    if (!(e.aerial.covered>1000 && Object.values(e.aerial.controls).every(x=>x>.15) && e.aerial.disabledDelta===0 && e.aerial.zeroDelta===0 && e.aerial.sunriseDelta>.15 && e.aerial.sunriseHash===e.aerial.sunriseRepeat && e.waterControls.disabledMatches && Object.entries(e.waterControls).filter(([k])=>k!=="disabledMatches").every(([,v])=>v>.001) && e.volumeTemporal.width===1920 && e.volumeTemporal.height===1080 && e.volumeTemporal.historyValid && e.volumeTemporal.outsideMax<=1 && e.volumeTemporal.insideChanged>20))throw new Error(`W10 added acceptance contracts failed: ${JSON.stringify(e)}`);
    const preservation=JSON.parse(readFileSync(join(packageRoot,"tests/golden/w10/w09-preservation.json"),"utf8"));
    if(JSON.stringify(e.preservation)!==JSON.stringify(preservation.frames))throw new Error("W10 absent environment changed W09 bytes");
    await page.goto(`${origin}/test-w10-native.html`,{waitUntil:"networkidle"});
    await page.waitForFunction(()=>typeof window.__w10NativeTerrain==="function");
    e.nativeScenes=await page.evaluate(()=>window.__w10NativeTerrain());
    for(const [name,r] of Object.entries(e.nativeScenes)) {
      delete r.actual;
      if(!(r.ssim>=.98 && r.historicalSsim>=.98 && (r.controlSsim===undefined || r.controlSsim<.98)))throw new Error(`Native W10 scene ${name} failed: ${JSON.stringify(r)}`);
    }

    if (!(e.render.covered>1000 && e.render.generalCovered>1000 && e.render.generalDelta>.1 && e.render.plain===e.render.cleared && e.render.cloud.hash===e.render.cloud.repeat && e.render.cloud.timeDelta>.01 && e.bounds.max<=1 && e.bounds.outsideMax<=1 && e.bounds.outsidePixels>10000 && e.bounds.insideChanged>20 && e.masks.zero===0 && e.masks.transparent && e.budget.code==="RESOURCE_LIMIT_EXCEEDED" && e.budget.before===e.budget.after && e.budget.bytes===e.budget.afterBytes && e.budget.report.width===224 && e.offline.nonzero && e.offline.captureRepeat && e.offline.waterIds.includes(4294967280) && e.recovery.same && e.recovery.attempts===1 && e.quality.halfDelta<2 && e.quality.froxelDelta<1 && e.quality.cameraReset===false && e.quality.occlusionDelta>.01 && e.native.every(c=>c.maxAbs<1e-3&&c.ssim>=.98&&c.controlSsim<.98) && e.worker.delta>.1 && e.downscale.selected.resolutionScale===.5 && e.downscale.before===e.downscale.after && e.cloudsAndWaves.firstSeed!==e.cloudsAndWaves.secondSeed && e.cloudsAndWaves.shadowDelta>.1 && e.cloudsAndWaves.planarDelta>.01 && e.cloudsAndWaves.waveDelta>.01 && e.restoreLights.baseline===e.restoreLights.cleared && e.restoreLights.baseline===e.restoreLights.sceneCleared && e.goldens.cloud.disabledSsim<.98 && e.goldens.water.disabledSsim<.98 && Object.values(e.goldens).every(c=>c.ssim>=.98&&c.controlSsim<.98))) throw new Error(`installed-package W10 contract failed: ${JSON.stringify(e)}`);
    if (pageErrors.length > 0) {
      throw new Error(`installed-package page errors: ${pageErrors.join("; ")}`);
    }
    return {
      packageSha256,
      launchArguments: [...browserProfile.launchArguments],
      adapter,
      interactionAssertions,
      screenshots: true,
      resize: true,
      disposal: true,
      unsupportedUi: true,
      unsupportedDiagnostic: edgeAcceptance,
      visibilityLifecycle,
      interactionObservation,
      evidence,
      w04Package: {
        shadow: w04Package.shadow,
        disabledShadow: w04Package.disabledShadow,
        ibl: w04Package.ibl,
        routes: w04Package.routes,
        basisAsset: w04Package.basisAsset,
      },
      w05Package: {
        projection: w05Package.projection,
        animation: w05Package.animation,
        rig: w05Package.rig,
        replay: w05Package.replay,
      },
      w06Package: {
        capture: w06Package.capture,
        offline: w06Package.offline,
        exr: w06Package.exr,
        frames: w06Package.frames,
        video: w06Package.video,
      },
      w09Package,
      w10Package,
      w08Package: {
        mainThread: w08Package.mainThread,
        worker: w08Package.worker,
        decodeParity: w08Package.decodeParity,
        render: w08Package.render,
      },
      terrainDataset: {
        direct: terrainDataset.sources.direct,
        file: terrainDataset.sources.file,
        url: terrainDataset.sources.url,
        demReadback: terrainDataset.demReadback,
        gpuParity: terrainDataset.gpuParity,
        resident: terrainDataset.resident,
        disabledAoCode: terrainDataset.disabledAoCode,
        disabledSunCode: terrainDataset.disabledSunCode,
        renderDiffers: terrainDataset.renderDiffers,
        memory: terrainDataset.memory,
      },
    };
  } finally {
    await browser.close();
  }
}

function run(command, args, cwd, capture = false) {
  const invocation = resolveCommandInvocation(command, args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}`);
  }
  return result.stdout ?? "";
}

function assertCleanWorktree(repositoryRoot) {
  const status = run(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    repositoryRoot,
    true,
  ).trimEnd();
  if (status !== "") {
    const preview = status.split(/\r?\n/).slice(0, 20).join("\n");
    throw new Error(
      `exact-HEAD browser evidence requires a clean worktree before build:\n${preview}`,
    );
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function createStaticServer(root) {
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const requested =
      url.pathname === "/" ? "/test-interactive-viewer.html" : url.pathname;
    const path = resolve(root, `.${requested}`);
    const relativePath = relative(root, path);
    if (
      relativePath === ".." ||
      relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
      isAbsolute(relativePath)
    ) {
      response.writeHead(403).end("forbidden");
      return;
    }
    let bytes;
    try {
      bytes = readFileSync(path);
    } catch {
      response.writeHead(404).end("not found");
      return;
    }
    const contentTypes = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".wasm": "application/wasm",
    };
    const headers = {
      "content-type": contentTypes[extname(path)] ?? "application/octet-stream",
      "cache-control": "no-store",
      "accept-ranges": "bytes",
    };
    // W08 COG streaming reads byte ranges and rejects a 200 full-body reply,
    // so serve single `bytes=` ranges as 206 like a range-capable host.
    const range = request.headers.range;
    if (range !== undefined) {
      const slice = parseByteRange(range, bytes.length);
      if (slice === null) {
        response
          .writeHead(416, { "content-range": `bytes */${bytes.length}` })
          .end();
        return;
      }
      response.writeHead(206, {
        ...headers,
        "content-range": `bytes ${slice.start}-${slice.end}/${bytes.length}`,
        "content-length": String(slice.end - slice.start + 1),
      });
      response.end(bytes.subarray(slice.start, slice.end + 1));
      return;
    }
    response.writeHead(200, headers);
    response.end(bytes);
  });
}

function parseByteRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (match === null || (match[1] === "" && match[2] === "")) return null;
  let start;
  let end;
  if (match[1] === "") {
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  return start <= end && start < size ? { start, end } : null;
}
