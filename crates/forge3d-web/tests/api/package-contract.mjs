import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const packageJson = readJson(join(root, "package.json"));

assertEqual(packageJson.type, "module", "package must be ESM-only");
assertEqual(packageJson.exports["."].import, "./dist/index.js", "package entrypoint must use dist/index.js");
assertEqual(packageJson.exports["."].types, "./types/index.d.ts", "package entrypoint must use hand-authored types");
assertEqual(packageJson.exports["./wasm"], "./dist/forge3d_web_bg.wasm", "wasm export must point at packaged dist asset");
assertIncludes(packageJson.files, "dist", "package files must include dist");
assertIncludes(packageJson.files, "types", "package files must include types");
assertIncludes(packageJson.files, "README.md", "package files must include README");
assertIncludes(packageJson.files, "LICENSE", "package files must include MIT license");
assertIncludes(packageJson.files, "LICENSE-APACHE", "package files must include Apache license");
assertIncludes(packageJson.scripts.build, "prepare-dist", "build must prepare publishable dist artifacts");

for (const relative of [
  "scripts/prepare-dist.mjs",
  "README.md",
  "LICENSE",
  "LICENSE-APACHE",
  "examples/vite/package.json",
  "examples/vite/index.html",
  "examples/vite/src/main.ts"
]) {
  assert(existsSync(join(root, relative)), `missing package artifact: ${relative}`);
}

const readme = readText(join(root, "README.md"));
for (const expected of [
  "## Browser Support",
  "## MIME, CORS, And Range Requirements",
  "## MVP Scope And Exclusions",
  "import { Forge3DRuntime } from \"@forge3d/web\""
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
