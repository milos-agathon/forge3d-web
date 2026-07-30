import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { resolveCommandInvocation } from "../../scripts/command-executable.mjs";
import { resolvePackageGateMode } from "../../scripts/package-gate-mode.mjs";

const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const repoRoot = join(packageRoot, "..", "..");

const packageJson = readJson(join(packageRoot, "package.json"));
const packageLock = readText(join(packageRoot, "package-lock.json"));
const infrastructureTestRunner = readText(
  join(packageRoot, "scripts", "run-infrastructure-tests.mjs"),
);
const benchmarkHarness = readText(
  join(packageRoot, "tests", "browser", "viewer-benchmark.ts"),
);
const interactionObservationHarness = readText(
  join(
    packageRoot,
    "tests",
    "browser",
    "viewer-interaction-observation.mjs",
  ),
);
const sourceEvidenceProducer = readText(
  join(packageRoot, "tests", "playwright", "viewer_benchmark.spec.ts"),
);
const installedPackageEvidenceProducer = readText(
  join(packageRoot, "scripts", "build-browser-test-package.mjs"),
);

assertEqual(
  normalizeNewlines("alpha\r\nbeta\rgamma"),
  "alpha\nbeta\ngamma",
  "release contract source reads must normalize Windows and legacy line endings",
);
assertEqual(packageJson.description, "Browser-only Forge3D WebGPU/WASM runtime for terrain rendering", "package description must match the browser MVP");
assertEqual(packageJson.repository?.type, "git", "package repository type must be declared");
assertEqual(packageJson.repository?.url, "git+https://github.com/milos-agathon/forge3d.git", "package repository URL must be declared");
assertEqual(packageJson.repository?.directory, "crates/forge3d-web", "package repository directory must point at the web crate");
assertEqual(packageJson.bugs?.url, "https://github.com/milos-agathon/forge3d/issues", "package issue tracker must be declared");
assertEqual(packageJson.homepage, "https://forge3d.dev", "package homepage must be declared");
assertEqual(packageJson.engines?.node, ">=20.19.0", "package Node support floor must match Vite/CI");
assertEqual(packageJson.forge3d?.interactiveViewer?.contractStage, "verification-incomplete", "viewer foundation stage must remain evidence-bound");
assertEqual(packageJson.forge3d?.interactiveViewer?.runtimeAvailable, true, "implemented viewer runtime must be declared");
assertEqual(packageJson.forge3d?.interactiveViewer?.releaseReady, false, "viewer support must remain release-matrix blocked");
assertEqual(packageJson.forge3d?.interactiveViewer?.implementationTasks, "FND-01..FND-07", "viewer implementation ownership must stay explicit");
assert(packageJson.sideEffects === false, "package must declare sideEffects false for ESM consumers");

for (const keyword of ["webgpu", "wasm", "terrain", "geospatial", "visualization"]) {
  assertIncludes(packageJson.keywords, keyword, `package keywords missing ${keyword}`);
}

assertIncludes(packageJson.scripts["test:package"], "release-hardening", "package test script must include release hardening checks");
assertIncludes(packageJson.scripts["test:package"], "test:infrastructure", "package test script must include infrastructure contracts");
assertEqual(
  packageJson.scripts["test:infrastructure"],
  "node scripts/run-infrastructure-tests.mjs",
  "infrastructure tests must use the cross-platform test runner",
);
assertIncludes(
  infrastructureTestRunner,
  '"browser-lab-broker", "test"',
  "infrastructure test runner must include the audited broker",
);
assertIncludes(
  infrastructureTestRunner,
  'entry.name.endsWith(".test.mjs")',
  "infrastructure test runner must select only test modules",
);
assertIncludes(
  infrastructureTestRunner,
  'spawnSync(process.execPath, ["--test", ...testFiles]',
  "infrastructure test runner must avoid shell-dependent glob expansion",
);
assertIncludes(packageJson.files, "docs", "package files must include release docs");
assert(!packageLock.includes("jfrog.booking.com"), "package lock must not depend on a private registry");
const windowsNpm = resolveCommandInvocation("npm", ["run", "build"], {
  operatingSystem: "win32",
  nodeExecutable: "C:\\node.exe",
  npmExecutable: "C:\\npm-cli.js",
});
assertEqual(windowsNpm.command, "C:\\node.exe", "Windows npm subprocesses must use the Node executable");
assertEqual(
  JSON.stringify(windowsNpm.args),
  JSON.stringify(["C:\\npm-cli.js", "run", "build"]),
  "Windows npm subprocesses must pass the npm CLI and original arguments directly",
);
const windowsGit = resolveCommandInvocation("git", ["status"], {
  operatingSystem: "win32",
});
assertEqual(windowsGit.command, "git", "native Windows executables must remain unchanged");
assertEqual(JSON.stringify(windowsGit.args), JSON.stringify(["status"]), "native executable arguments must remain unchanged");
assertEqual(resolvePackageGateMode(undefined), "required", "package gate must default to required evidence");
assertEqual(resolvePackageGateMode("required"), "required", "package gate must accept required evidence mode");
assertEqual(resolvePackageGateMode("probe"), "probe", "package gate must accept hosted probe mode");
assertThrows(
  () => resolvePackageGateMode("pass"),
  /must be either required or probe/,
  "package gate must reject unknown evidence modes",
);

assertIncludes(
  benchmarkHarness,
  "viewer.setView(samples[index]);\n          index += 1;\n          requestAnimationFrame(apply);",
  "frozen benchmark v1 must apply each measured sample on consecutive harness RAF callbacks",
);
for (const forbidden of [
  "MINIMUM_INTERACTION_DURATION_MS",
  "requestAtOrAfter",
  "setTimeout(",
]) {
  assert(
    !benchmarkHarness.includes(forbidden),
    `frozen benchmark v1 must not contain ${forbidden}`,
  );
}
for (const expected of [
  "MINIMUM_VIEWER_INTERACTION_DURATION_MS = 10_000",
  'page.on("console", onConsole)',
  'page.on("pageerror", onPageError)',
  "onError: (error) =>",
  "uncapturedValidationErrors",
  "export function isWebGpuValidationError",
  "requestAnimationFrame(apply)",
  "supportPromotionEligible: false",
]) {
  assertIncludes(
    interactionObservationHarness,
    expected,
    `viewer interaction observation must retain ${expected}`,
  );
}
assert(
  !interactionObservationHarness.includes(
    'message.type() === "error"',
  ),
  "viewer interaction observation must inspect WebGPU validation text at every console level",
);
for (const [label, producer] of [
  ["source", sourceEvidenceProducer],
  ["installed-package", installedPackageEvidenceProducer],
]) {
  assertIncludes(
    producer,
    "interactionObservation.normalizedErrorCodes",
    `${label} evidence must retain observed interaction error codes`,
  );
  assert(
    !producer.includes("normalizedErrorCodes: []"),
    `${label} evidence must not claim an unobserved empty error list`,
  );
}
assertIncludes(
  sourceEvidenceProducer,
  'testInfo.attach("forge3d-viewer-interaction-observation.json"',
  "source evidence must attach the separate interaction observation",
);
const sourceObservationCallIndex = sourceEvidenceProducer.indexOf(
  "await runViewerInteractionObservation(page, {",
);
const sourceInteractionExerciseCallIndex = sourceEvidenceProducer.indexOf(
  "await exerciseRequiredInteractions(page)",
);
assert(
  sourceObservationCallIndex >= 0 &&
    sourceInteractionExerciseCallIndex > sourceObservationCallIndex,
  "source evidence must run the owned interaction observation before creating a viewer for required interactions",
);
assertIncludes(
  installedPackageEvidenceProducer,
  "interactionObservation,\n      evidence,",
  "installed-package gate must retain interaction observation beside v3 evidence",
);

for (const relative of [
  "docs/support-matrix.md",
  "docs/release-checklist.md",
  "examples/vite/README.md"
]) {
  assert(existsSync(join(packageRoot, relative)), `missing release document: ${relative}`);
}

for (const relative of [
  "docs/browser-lab-runbook.md",
  "tests/infrastructure/browser-policy.json",
  "tests/infrastructure/hardware-matrix.json",
  "tests/infrastructure/repository-trust-policy.json",
  "tests/infrastructure/runner-distribution-manifest.json",
  "tests/infrastructure/workflow-actions-lock.json",
]) {
  assert(existsSync(join(packageRoot, relative)), `missing INF-00 contract: ${relative}`);
}

const readme = readText(join(packageRoot, "README.md"));
for (const expected of [
  "## Interactive Viewer Status",
  "FND-01..FND-07",
  "not independently release-ready",
  "See `docs/support-matrix.md`",
  "See `docs/release-checklist.md`",
  "See `docs/browser-lab-runbook.md`",
  "Cache `.wasm` assets with immutable content hashing",
  "npm run test:package"
]) {
  assertIncludes(readme, expected, `README missing release guidance: ${expected}`);
}

const supportMatrix = readText(join(packageRoot, "docs", "support-matrix.md"));
for (const expected of [
  "| Surface | MVP status | Notes |",
  "| Chrome/Chromium on Windows | Required |",
  "| Firefox | Unsupported |",
  "| Safari | Unsupported |",
  "| WebGL fallback | Unsupported |",
  '$env:FORGE3D_WEBGPU_REQUIRED = "1"'
]) {
  assertIncludes(supportMatrix, expected, `support matrix missing: ${expected}`);
}

const checklist = readText(join(packageRoot, "docs", "release-checklist.md"));
for (const expected of [
  "## Interactive Viewer Release Blocker",
  "package.json#forge3d.interactiveViewer.releaseReady",
  "npm ci",
  "$env:PATH = \"$pwd\\crates\\forge3d-web\\node_modules\\.bin;$env:PATH\"",
  "cargo clippy -p forge3d-core --target wasm32-unknown-unknown --no-default-features -- -D warnings",
  "cargo clippy -p forge3d-web --target wasm32-unknown-unknown -- -D warnings",
  "cargo test -p forge3d-core --features gpu",
  "cargo test -p forge3d-web",
  "cargo check -p forge3d-core --target wasm32-unknown-unknown --no-default-features",
  "cargo check -p forge3d-web --target wasm32-unknown-unknown",
  ".\\crates\\forge3d-web\\node_modules\\.bin\\wasm-pack.cmd build crates/forge3d-web --target web",
  "npm run build",
  "npm run test:package",
  "npm run test:infrastructure",
  'FORGE3D_SOURCE_BENCHMARK_MODE = "required"',
  "npm pack --dry-run",
  "performance measurement, not the CHR-02 ten-second clock",
  "sibling outside the unchanged v3 browser evidence record"
]) {
  assertIncludes(checklist, expected, `release checklist missing: ${expected}`);
}

const browserApi = readText(join(packageRoot, "docs", "browser-api.md"));
for (const expected of [
  "## Interactive Viewer API",
  "implements the frozen high-level surface",
  "code completion alone is not",
  "arrows orbit",
  "Shift+arrows pan",
  "`+`/`-` zoom",
  "Home",
  "deterministic synthetic",
  "second real browser tab",
  "Neither a hidden document nor an occluded/skipped frame emits",
  "must be incorporated into the separately attested branded, physical browser"
]) {
  assertIncludes(browserApi, expected, `browser API staging contract missing: ${expected}`);
}

const webWorkflow = readText(join(repoRoot, ".github", "workflows", "web.yml"));
assertIncludes(webWorkflow, "npm ci --registry=https://registry.npmjs.org", "required web workflow must install from the public npm registry");
assertIncludes(webWorkflow, "Test-Path node_modules/.bin/wasm-pack.cmd", "required web workflow must reject incomplete npm installs");
assertIncludes(webWorkflow, "FORGE3D_PACKAGE_GATE_MODE: probe", "hosted web workflow must not claim fallback hardware as release evidence");
assertIncludes(webWorkflow, "FORGE3D_SOURCE_BENCHMARK_MODE: probe", "hosted web workflow must not benchmark fallback hardware as release evidence");
assertIncludes(webWorkflow, "run: cargo test -p forge3d-core --features gpu", "required web workflow must test core GPU contracts");
assertIncludes(webWorkflow, "run: cargo test -p forge3d-web", "required web workflow must test web crate contracts");
assertIncludes(webWorkflow, "run: npm run build:wasm", "required web workflow must invoke the pinned wasm-pack npm script");
assertIncludes(webWorkflow, "run: npm run test:api", "required web workflow must enforce the API snapshot");
assertIncludes(webWorkflow, "run: npm run test:package", "required web workflow must enforce package staging metadata");
assertIncludes(webWorkflow, "run: npm run test:package-consumer", "required web workflow must execute the installed tarball in Chrome");
assert(
  !webWorkflow.split("\n").some((line) => /^\s*wasm-pack\s+build\b/.test(line)),
  "required web workflow must not rely on bare wasm-pack being available on PATH"
);

for (const forbidden of [
  "maturin",
  "forge3d-python",
  "forge3d-native-viewer",
  "pytest tests/test_install_smoke.py"
]) {
  assert(!checklist.includes(forbidden), `release checklist must not include browser-removed gate: ${forbidden}`);
}

assert(
  !checklist.includes("\nwasm-pack build crates/forge3d-web --target web\n"),
  "release checklist must not rely on bare wasm-pack being available on PATH"
);

const viteReadme = readText(join(packageRoot, "examples", "vite", "README.md"));
for (const expected of [
  "npm run build",
  "@forge3d/web",
  "navigator.gpu",
  "application/wasm"
]) {
  assertIncludes(viteReadme, expected, `Vite README missing: ${expected}`);
}

const changelog = readText(join(repoRoot, "CHANGELOG.md"));
assertIncludes(changelog, "Hardened the browser WebGPU/WASM MVP prerelease", "changelog must describe Phase 16 release hardening");

const plan = readText(join(repoRoot, "docs", "superpowers", "plans", "2026-06-04-forge3d-browser-webgpu-wasm-runtime.md"));
assertIncludes(plan, "browser/npm/WASM-only repository", "plan must declare browser-only repository scope");
assertIncludes(plan, "Python/PyO3, maturin, native desktop viewers", "plan must mark Python/native surfaces out of scope");

function readJson(path) {
  return JSON.parse(readText(path));
}

function readText(path) {
  return normalizeNewlines(readFileSync(path, "utf8"));
}

function normalizeNewlines(value) {
  return value.replace(/\r\n?/g, "\n");
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

function assertThrows(callback, expected, message) {
  try {
    callback();
  } catch (error) {
    if (expected.test(String(error?.message ?? error))) {
      return;
    }
    throw error;
  }
  throw new Error(message);
}
