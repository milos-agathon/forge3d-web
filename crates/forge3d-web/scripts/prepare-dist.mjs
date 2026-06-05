import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
