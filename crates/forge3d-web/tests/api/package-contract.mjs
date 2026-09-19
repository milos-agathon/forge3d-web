import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

import { CHROMIUM_PRIMARY_ROWS } from "../../scripts/chromium-support-publication.mjs";
import { CHR03_STABLE_LANES } from "../../scripts/chr03-lanes.mjs";
import { CHR04_LANES } from "../../scripts/chr04-lanes.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const packageJson = readJson(join(root, "package.json"));
const consumerHarness = readText(
  join(root, "scripts", "build-browser-test-package.mjs"),
);
const edgeAcceptanceHarness = readText(
  join(root, "scripts", "edge-browser-acceptance.mjs"),
);
const declarations = readText(join(root, "types", "index.d.ts"));

assertEqual(packageJson.type, "module", "package must be ESM-only");
assertEqual(packageJson.exports["."].import, "./dist/index.js", "package entrypoint must use dist/index.js");
assertEqual(packageJson.exports["."].types, "./types/index.d.ts", "package entrypoint must use hand-authored types");
assertEqual(
  declarations.split("ownedAnimationFrameCount: number").length - 1,
  1,
  "shipped ViewerDiagnostics must expose exactly one owned RAF handle count",
);
assertEqual(packageJson.exports["./wasm"], "./dist/forge3d_web_bg.wasm", "wasm export must point at packaged dist asset");
assertIncludes(packageJson.files, "dist", "package files must include dist");
assertIncludes(packageJson.files, "docs", "package files must include docs");
assertIncludes(packageJson.files, "types", "package files must include types");
assertIncludes(packageJson.files, "README.md", "package files must include README");
assertIncludes(packageJson.files, "LICENSE", "package files must include MIT license");
assertIncludes(packageJson.files, "LICENSE-APACHE", "package files must include Apache license");
assertIncludes(packageJson.scripts.build, "prepare-dist", "build must prepare publishable dist artifacts");
assertEqual(
  packageJson.scripts["test:package-consumer"],
  "node scripts/build-browser-test-package.mjs",
  "package consumer command must use the shared tarball harness",
);
for (const [name, command] of Object.entries({
  "test:browser": "playwright test --project=chromium-preflight",
  "test:browser:chromium": "playwright test --project=chromium-preflight",
  "test:browser:chrome": "playwright test --project=chrome-stable",
  "test:browser:edge": "playwright test --project=edge-stable",
})) assertEqual(packageJson.scripts[name], command, `browser command mapping drifted: ${name}`);

const matrix = readJson(join(root, "tests", "infrastructure", "hardware-matrix.json"));
const expectedPrimaryRows = {
  "chrome-windows-intel12": "FW-WIN-I12-01",
  ...CHR03_STABLE_LANES,
  ...Object.fromEntries(
    Object.entries(CHR04_LANES)
      .filter(([, value]) => value.requirement === "required")
      .map(([lane, value]) => [lane, value.assetId]),
  ),
};
assertEqual(
  JSON.stringify(CHROMIUM_PRIMARY_ROWS),
  JSON.stringify(expectedPrimaryRows),
  "six Chromium publication keys must agree with the CHR-03/04 registries",
);
for (const [lane, assetId] of Object.entries(expectedPrimaryRows)) {
  const host = matrix.hosts.find((candidate) => candidate.assetId === assetId);
  assert(host?.requiredBrowserLanes.includes(lane), `matrix missing primary Chromium lane ${lane}`);
}
assertEqual(Object.keys(expectedPrimaryRows).length, 6, "Chromium primary set must contain six rows");
for (const expected of [
  "chromium.launch",
  "page.goto",
  "viewer.screenshot()",
  "viewer.resize",
  "viewer.dispose()",
  "wheel:",
  "runEdgeBrowserAcceptance",
  "exerciseViewerVisibilityLifecycle",
  "visibilityLifecycle",
  "runViewerInteractionObservation",
  "interactionObservation",
  "validateBrowserEvidence(evidence)",
  "--porcelain=v1",
  "FORGE3D_EVIDENCE_DIR",
  "copyFileSync(tarball",
]) {
  assertIncludes(
    consumerHarness,
    expected,
    `package consumer browser gate missing ${expected}`,
  );
}
for (const expected of [
  "pointerType: \"touch\"",
  "WEBGPU_UNAVAILABLE",
  "WEBGPU_ADAPTER_UNAVAILABLE",
  "physicalPolicyProof: false",
  "withIsolatedBrowserContext",
]) {
  assertIncludes(edgeAcceptanceHarness, expected, `shared Edge acceptance helper missing ${expected}`);
}
const lifecycleCallIndex = consumerHarness.indexOf(
  "const visibilityLifecycle",
);
const disposalCallIndex = consumerHarness.indexOf("viewer.dispose();");
assert(
  lifecycleCallIndex >= 0 && disposalCallIndex > lifecycleCallIndex,
  "package consumer must run the shared visibility lifecycle before disposal",
);
const interactionObservationCallIndex = consumerHarness.indexOf(
  "runViewerInteractionObservation(page)",
);
assert(
  interactionObservationCallIndex >= 0 &&
    disposalCallIndex > interactionObservationCallIndex,
  "package consumer must run the shared interaction observation before disposal",
);

for (const relative of [
  "scripts/prepare-dist.mjs",
  "scripts/build-browser-test-package.mjs",
  "README.md",
  "docs/support-matrix.md",
  "docs/release-checklist.md",
  "LICENSE",
  "LICENSE-APACHE",
  "examples/vite/package.json",
  "examples/vite/index.html",
  "examples/vite/src/main.ts",
  "examples/test-interactive-viewer.html",
  "tests/browser/browser-evidence.schema.json",
  "tests/browser/evidence-validator.mjs",
  "tests/browser/viewer-interaction-observation.mjs",
  "tests/browser/viewer-visibility-lifecycle.mjs",
  "tests/browser/viewer-benchmark.ts",
  "tests/browser/viewer-benchmark-browser.js",
  "tests/browser/chr03-hardware-proof.schema.json",
  "tests/browser/chr04-hardware-proof.schema.json",
  "scripts/chrome-hardware-acceptance.mjs",
  "scripts/edge-browser-acceptance.mjs",
  "scripts/chr03-hardware-proof-validator.mjs",
  "scripts/chr04-hardware-proof-validator.mjs",
  "scripts/chr04-lanes.mjs",
  "tests/browser/benchmark/benchmark-manifest-v1.json",
  "tests/browser/benchmark/benchmark-terrain-v1.f32le",
  "tests/browser/benchmark/benchmark-trace-v1.json"
]) {
  assert(existsSync(join(root, relative)), `missing package artifact: ${relative}`);
}

const supportMatrix = readText(join(root, "docs", "support-matrix.md"));
for (const expected of [
  "| Safari Technology Preview | Unsupported |",
  "Non-blocking early warning only",
  "Every result remains `NOT_PROVEN`",
  "Safari Technology Preview cannot establish stable Safari support",
]) {
  assert(
    supportMatrix.includes(expected),
    `packaged support matrix missing Safari Technology Preview distinction: ${expected}`,
  );
}

const readme = readText(join(root, "README.md"));
const supportMatrix = readText(join(root, "docs/support-matrix.md"));
for (const expected of [
  "Chrome stable on Intel macOS",
  "Chrome stable on AMD/Linux",
  "P2, `NOT_PROVEN`",
  "six primary configured rows",
  "Edge Linux stays conditional/P2",
  "derivative Chromium brands",
  "non-Wayland Linux",
  "`chromium-support.md`",
]) {
  assertIncludes(supportMatrix, expected, `support matrix missing CHR-03 boundary: ${expected}`);
}
for (const expected of [
  "## Browser Support",
  "## MIME, CORS, And Range Requirements",
  "## MVP Scope And Exclusions",
  "import { Forge3DRuntime } from \"@forge3d/web\"",
  "SAF-05 adds a fail-closed publication guard",
  "Unsupported/`NOT_PROVEN`",
]) {
  assertIncludes(readme, expected, `README missing package guidance: ${expected}`);
}

const viteMain = readText(join(root, "examples/vite/src/main.ts"));
assertIncludes(viteMain, "from \"@forge3d/web\"", "Vite example must import from package entrypoint");

const distIndexPath = join(root, "dist", "index.js");
const distWasmJsPath = join(root, "dist", "forge3d_web.js");
const distWasmPath = join(root, "dist", "forge3d_web_bg.wasm");
assert(existsSync(distIndexPath), "dist/index.js must exist after npm run build");
assert(existsSync(distWasmJsPath), "dist/forge3d_web.js must exist after npm run build");
assert(existsSync(distWasmPath), "dist/forge3d_web_bg.wasm must exist after npm run build");

const distIndex = readText(distIndexPath);
assertIncludes(distIndex, "\"./forge3d_web.js\"", "dist facade must load packaged wasm bridge locally");
assertNotIncludes(distIndex, "../pkg/forge3d_web.js", "dist facade must not reference unpublished pkg directory");
const packagedFacade = await import(
  `${pathToFileURL(distIndexPath).href}?contract=${Date.now()}`
);
for (const forbidden of [
  "setDeviceLostHandler",
  "simulateDeviceLossForTesting",
]) {
  assert(
    !(forbidden in packagedFacade.Forge3DRuntime.prototype),
    `packaged runtime prototype must not expose ${forbidden}`,
  );
}

const dryRun = execSync("npm pack --dry-run --json", {
  cwd: root,
  encoding: "utf8"
});
const [pack] = JSON.parse(dryRun);
const files = new Set(pack.files.map((file) => file.path.replaceAll("\\", "/")));
for (const expected of [
  "dist/index.js",
  "dist/forge3d_web.js",
  "dist/forge3d_web_bg.wasm",
  "docs/support-matrix.md",
  "docs/release-checklist.md",
  "types/index.d.ts",
  "README.md",
  "LICENSE",
  "LICENSE-APACHE"
]) {
  assert(files.has(expected), `npm pack dry-run missing ${expected}`);
}

function readJson(path) {
  return JSON.parse(readText(path));
}

function readText(path) {
  return readFileSync(path, "utf8");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function assertIncludes(value, expected, message) {
  if (!value.includes(expected)) {
    throw new Error(message);
  }
}

function assertNotIncludes(value, expected, message) {
  if (value.includes(expected)) {
    throw new Error(message);
  }
}
