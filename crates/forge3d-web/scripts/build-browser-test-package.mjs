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
import { resolveInstalledTarballBrowserProfile } from "./installed-tarball-browser-profile.mjs";
import { resolvePackageGateMode } from "./package-gate-mode.mjs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = resolve(packageRoot, "..", "..");
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
  run("npm", ["run", "test:package"], packageRoot);
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
      'import { Forge3DViewer } from "@forge3d/web"; if (typeof Forge3DViewer !== "function") throw new Error("Forge3DViewer export missing");',
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
    const afterTouch = await page.evaluate(() => {
      const fixture = window.__forge3dInteractiveViewer;
      const event = (type, x, y) =>
        new PointerEvent(type, {
          bubbles: true,
          pointerId: 73,
          pointerType: "touch",
          clientX: x,
          clientY: y,
          isPrimary: true,
        });
      fixture.canvas.dispatchEvent(event("pointerdown", 120, 120));
      fixture.canvas.dispatchEvent(event("pointermove", 150, 95));
      fixture.canvas.dispatchEvent(event("pointerup", 150, 95));
      return fixture.viewer.getView();
    });
    const interactionAssertions = {
      mouse: JSON.stringify(afterMouse) !== JSON.stringify(initial.view),
      wheel: JSON.stringify(afterWheel) !== JSON.stringify(afterMouse),
      keyboard: JSON.stringify(afterKeyboard) !== JSON.stringify(afterWheel),
      touch: JSON.stringify(afterTouch) !== JSON.stringify(afterKeyboard),
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
    for (const [name, passed] of Object.entries(interactionAssertions)) {
      if (!passed) {
        throw new Error(
          `installed-package ${name} interaction did not independently satisfy its assertion`,
        );
      }
    }
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
    await verifyUnsupportedUi(browser, origin);
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
      visibilityLifecycle,
      interactionObservation,
      evidence,
    };
  } finally {
    await browser.close();
  }
}

async function verifyUnsupportedUi(browser, origin) {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "gpu", {
      configurable: true,
      get: () => undefined,
    });
  });
  const page = await context.newPage();
  try {
    await page.goto(`${origin}/test-interactive-viewer.html`);
    const result = await page.evaluate(async () => {
      await window.__forge3dInteractiveViewer.create().catch(() => undefined);
      const unsupported = document.querySelector("#unsupported");
      const status = document.querySelector("#status");
      return {
        unsupportedVisible: unsupported?.hidden === false,
        status: status?.value,
      };
    });
    if (!result.unsupportedVisible || result.status !== "unsupported") {
      throw new Error("installed-package unsupported UI did not activate");
    }
  } finally {
    await context.close();
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
    response.writeHead(200, {
      "content-type": contentTypes[extname(path)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(bytes);
  });
}
