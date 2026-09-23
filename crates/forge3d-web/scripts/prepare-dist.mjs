import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = join(root, "..", "..");
const dist = join(root, "dist");
const pkg = join(root, "pkg");

mkdirSync(dist, { recursive: true });

copyRequired(join(pkg, "forge3d_web.js"), join(dist, "forge3d_web.js"));
copyRequired(join(pkg, "forge3d_web_bg.wasm"), join(dist, "forge3d_web_bg.wasm"));
copyRequired(join(repoRoot, "LICENSE"), join(root, "LICENSE"));
copyRequired(join(repoRoot, "LICENSE-APACHE"), join(root, "LICENSE-APACHE"));

const facadePath = join(dist, "index.js");
let facade = readRequired(facadePath);
facade = facade.replace(
  "\"../pkg/forge3d_web.js\"",
  "\"./forge3d_web.js\""
);
if (facade.includes("../pkg/forge3d_web.js")) {
  throw new Error("dist/index.js still references unpublished pkg directory");
}
writeFileSync(facadePath, facade);

// ktx-parse is lock-controlled as bundled-self-hosted: ship the exact
// integrity-verified 1.1.0 module under dist/ so the package resolves it
// from 'self' without a bundler or import-map entry.
const ktxRoot = join(root, "node_modules", "ktx-parse");
const ktxVersion = JSON.parse(readRequired(join(ktxRoot, "package.json"))).version;
if (ktxVersion !== "1.1.0") {
  throw new Error(`ktx-parse must be 1.1.0 per the dependency lock, found ${ktxVersion}`);
}
const vendor = join(dist, "vendor");
mkdirSync(vendor, { recursive: true });
copyRequired(join(ktxRoot, "dist", "ktx-parse.modern.js"), join(vendor, "ktx-parse.js"));
copyRequired(join(ktxRoot, "LICENSE"), join(vendor, "ktx-parse.LICENSE"));
for (const file of readdirSync(dist)) {
  if (!file.endsWith(".js")) continue;
  const path = join(dist, file);
  const source = readFileSync(path, "utf8");
  const rewritten = source.replaceAll("from \"ktx-parse\"", "from \"./vendor/ktx-parse.js\"");
  if (/from\s+["']ktx-parse["']/u.test(rewritten)) {
    throw new Error(`dist/${file} still imports the bare ktx-parse specifier`);
  }
  if (rewritten !== source) writeFileSync(path, rewritten);
}

// Package asset manifest: SHA-256 of every emitted self-hosted third-party asset.
const assetManifest = [
  ["dist/vendor/ktx-parse.js", "ktx-parse@1.1.0"],
  ["assets/basis/basis_transcoder.js", "basis_universal@2.0.3"],
  ["assets/basis/basis_transcoder.wasm", "basis_universal@2.0.3"],
].map(([path, source]) => ({
  path,
  source,
  sha256: createHash("sha256").update(readFileSync(join(root, path))).digest("hex"),
}));
writeFileSync(
  join(dist, "asset-manifest.json"),
  `${JSON.stringify({ assets: assetManifest }, undefined, 2)}\n`,
);

function copyRequired(from, to) {
  if (!existsSync(from)) {
    throw new Error(`Missing required package source: ${from}`);
  }
  copyFileSync(from, to);
}

function readRequired(path) {
  if (!existsSync(path)) {
    throw new Error(`Missing required package source: ${path}`);
  }
  return readFileSync(path, "utf8");
}
