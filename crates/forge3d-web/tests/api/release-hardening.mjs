import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const repoRoot = join(packageRoot, "..", "..");

const packageJson = readJson(join(packageRoot, "package.json"));

assertEqual(packageJson.description, "Browser-only Forge3D WebGPU/WASM runtime for terrain rendering", "package description must match the browser MVP");
assertEqual(packageJson.repository?.type, "git", "package repository type must be declared");
assertEqual(packageJson.repository?.url, "git+https://github.com/milos-agathon/forge3d.git", "package repository URL must be declared");
assertEqual(packageJson.repository?.directory, "crates/forge3d-web", "package repository directory must point at the web crate");
assertEqual(packageJson.bugs?.url, "https://github.com/milos-agathon/forge3d/issues", "package issue tracker must be declared");
assertEqual(packageJson.homepage, "https://forge3d.dev", "package homepage must be declared");
assertEqual(packageJson.engines?.node, ">=20.19.0", "package Node support floor must match Vite/CI");
assert(packageJson.sideEffects === false, "package must declare sideEffects false for ESM consumers");

for (const keyword of ["webgpu", "wasm", "terrain", "geospatial", "visualization"]) {
  assertIncludes(packageJson.keywords, keyword, `package keywords missing ${keyword}`);
}

assertIncludes(packageJson.scripts["test:package"], "release-hardening", "package test script must include release hardening checks");
assertIncludes(packageJson.files, "docs", "package files must include release docs");

for (const relative of [
  "docs/support-matrix.md",
  "docs/release-checklist.md",
  "examples/vite/README.md"
]) {
  assert(existsSync(join(packageRoot, relative)), `missing release document: ${relative}`);
}

const readme = readText(join(packageRoot, "README.md"));
for (const expected of [
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
  "FORGE3D_WEBGPU_REQUIRED=1"
]) {
  assertIncludes(supportMatrix, expected, `support matrix missing: ${expected}`);
}

const checklist = readText(join(packageRoot, "docs", "release-checklist.md"));
for (const expected of [
  "npm ci",
  "$env:PATH = \"$pwd\\crates\\forge3d-web\\node_modules\\.bin;$env:PATH\"",
  "cargo check -p forge3d-core --target wasm32-unknown-unknown --no-default-features",
  "cargo check -p forge3d-web --target wasm32-unknown-unknown",
  ".\\crates\\forge3d-web\\node_modules\\.bin\\wasm-pack.cmd build crates/forge3d-web --target web",
  "npm run build",
  "npm run test:package",
  "npm pack --dry-run",
  "python -m maturin build --manifest-path crates/forge3d-python/Cargo.toml --release --out dist"
]) {
  assertIncludes(checklist, expected, `release checklist missing: ${expected}`);
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
assertIncludes(plan, "| 16 | MVP release hardening (Done) |", "Phase 16 plan row must be marked done");

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
