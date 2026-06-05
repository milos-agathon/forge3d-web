import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const typesPath = join(root, "types", "index.d.ts");
const snapshotPath = join(root, "tests", "api", "index.d.ts.snapshot");
const facadePath = join(root, "src-ts", "index.ts");
const docsPath = join(root, "docs", "browser-api.md");

const types = readText(typesPath);
const snapshot = readText(snapshotPath);
const facade = readText(facadePath);
const docs = readText(docsPath);

assertEqual(normalize(types), normalize(snapshot), "types/index.d.ts changed without updating the public API snapshot");

for (const expected of [
  "export type Forge3DErrorCode",
  "export declare class Forge3DError extends Error",
  "export interface Forge3DRuntimeOptions",
  "export interface TerrainHeightmapInput",
  "export interface CameraInput",
  "export interface ResizeInput",
  "export declare class Forge3DRuntime",
  "static create(",
  "setTerrain(terrain: TerrainHeightmapInput): void",
  "setCamera(camera: CameraInput): void",
  "resize(size: ResizeInput): void",
  "render(): void",
  "screenshot(): Promise<Blob>",
  "dispose(): void"
]) {
  assertIncludes(types, expected, `missing public declaration: ${expected}`);
}

for (const leaked of [
  "WasmRuntime",
  "WasmBridge",
  "wasm_bindgen",
  "__wbg",
  "free():",
  "../pkg/"
]) {
  assertNotIncludes(types, leaked, `generated wasm detail leaked through declarations: ${leaked}`);
}

for (const expected of [
  "interface WasmRuntime",
  "interface WasmBridge",
  "const modulePath = \"../pkg/forge3d_web.js\"",
  "export class Forge3DRuntime"
]) {
  assertIncludes(facade, expected, `facade must keep generated wasm bridge private: ${expected}`);
}

for (const expected of [
  "## Public API",
  "## Lifetime Rules",
  "## Error Codes",
  "Forge3DRuntime.create(canvas, options)",
  "setTerrain(terrain)",
  "setCamera(camera)",
  "resize(size)",
  "screenshot()",
  "RUNTIME_DISPOSED"
]) {
  assertIncludes(docs, expected, `browser API docs missing: ${expected}`);
}

function readText(path) {
  return readFileSync(path, "utf8");
}

function normalize(text) {
  return text.replace(/\r\n/g, "\n").trimEnd();
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message);
  }
}

function assertIncludes(text, needle, message) {
  if (!text.includes(needle)) {
    throw new Error(message);
  }
}

function assertNotIncludes(text, needle, message) {
  if (text.includes(needle)) {
    throw new Error(message);
  }
}
