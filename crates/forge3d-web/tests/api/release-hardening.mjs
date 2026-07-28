import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { resolveCommandInvocation } from "../../scripts/command-executable.mjs";
import { resolvePackageGateMode } from "../../scripts/package-gate-mode.mjs";

const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const repoRoot = join(packageRoot, "..", "..");

const packageJson = readJson(join(packageRoot, "package.json"));
const packageLock = readText(join(packageRoot, "package-lock.json"));

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

for (const relative of [
  "docs/support-matrix.md",
  "docs/release-checklist.md",
  "examples/vite/README.md"
]) {
  assert(existsSync(join(packageRoot, relative)), `missing release document: ${relative}`);
}

const readme = readText(join(packageRoot, "README.md"));
for (const expected of [
  "## Interactive Viewer Status",
  "FND-01..FND-07",
  "not independently release-ready",
  "See `docs/support-matrix.md`",
  "See `docs/release-checklist.md`",
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
  "cargo check -p forge3d-core --target wasm32-unknown-unknown --no-default-features",
  "cargo check -p forge3d-web --target wasm32-unknown-unknown",
  ".\\crates\\forge3d-web\\node_modules\\.bin\\wasm-pack.cmd build crates/forge3d-web --target web",
  "npm run build",
  "npm run test:package",
  'FORGE3D_SOURCE_BENCHMARK_MODE = "required"',
  "npm pack --dry-run"
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
  "Home"
]) {
  assertIncludes(browserApi, expected, `browser API staging contract missing: ${expected}`);
}

const webWorkflow = readText(join(repoRoot, ".github", "workflows", "web.yml"));
assertIncludes(webWorkflow, "npm ci --registry=https://registry.npmjs.org", "required web workflow must install from the public npm registry");
assertIncludes(webWorkflow, "Test-Path node_modules/.bin/wasm-pack.cmd", "required web workflow must reject incomplete npm installs");
assertIncludes(webWorkflow, "FORGE3D_PACKAGE_GATE_MODE: probe", "hosted web workflow must not claim fallback hardware as release evidence");
assertIncludes(webWorkflow, "FORGE3D_SOURCE_BENCHMARK_MODE: probe", "hosted web workflow must not benchmark fallback hardware as release evidence");
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
