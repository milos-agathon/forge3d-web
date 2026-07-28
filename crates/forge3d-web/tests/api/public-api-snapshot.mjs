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
  "powerPreference?: \"none\" | \"low-power\" | \"high-performance\"",
  "wasmUrl?: string | URL",
  "export interface Forge3DRuntimeCapabilities",
  "export type ViewerStatus",
  "export type ViewerResourcePreset",
  "export interface OrbitView",
  "export interface OrbitControlsOptions",
  "export interface ViewerResizeOptions",
  "export interface ViewerRecoveryOptions",
  "export interface ViewerResourceBudget",
  "export interface ViewerResourceOptions",
  "export interface ViewerCapabilities",
  "export interface ViewerDiagnostics",
  "export interface ViewerStatusChange",
  "export interface Forge3DViewerOptions",
  "controls?: false | OrbitControlsOptions",
  "resize?: false | ViewerResizeOptions",
  "onStatusChange?: (change: ViewerStatusChange) => void",
  "onError?: (error: Forge3DError) => void",
  "export interface TerrainHeightmapInput",
  "export interface TerrainColorRampInput",
  "export interface TerrainColorStopInput",
  "export interface TerrainSourceProgress",
  "export type TerrainByteSource",
  "export interface TerrainHeightmapSourceInput",
  "export interface CameraInput",
  "export interface ResizeInput",
  "export declare class Forge3DRuntime",
  "export declare class Forge3DViewer",
  "static create(",
  "getCapabilities(): Forge3DRuntimeCapabilities",
  "getCapabilities(): ViewerCapabilities",
  "getDiagnostics(): ViewerDiagnostics",
  "setTerrain(terrain: TerrainHeightmapInput): void",
  "setTerrainFromSource(terrain: TerrainHeightmapSourceInput): Promise<void>",
  "setCamera(camera: CameraInput): void",
  "setView(view: OrbitView): void",
  "resetView(): void",
  "resize(size: ResizeInput): void",
  "render(): void",
  "screenshot(): Promise<Blob>",
  "dispose(): void"
]) {
  assertIncludes(types, expected, `missing public declaration: ${expected}`);
}

for (const code of [
  "INSECURE_CONTEXT",
  "WASM_LOAD_FAILED",
  "DEVICE_LOST",
  "INTERNAL_ERROR",
  "RESOURCE_LIMIT_EXCEEDED"
]) {
  assertIncludes(types, `| "${code}"`, `missing frozen error code: ${code}`);
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

for (const browserMode of [
  "browser?:",
  "browserName?:",
  "browserEngine?:",
  "userAgent?:",
  "userAgentMode?:"
]) {
  assertNotIncludes(types, browserMode, `browser-specific public option leaked into declarations: ${browserMode}`);
}

for (const expected of [
  "interface WasmRuntime",
  "interface WasmBridge",
  "const modulePath = \"../pkg/forge3d_web.js\"",
  "export class Forge3DRuntime",
  "options.wasmUrl !== undefined",
  "const { wasmUrl: _wasmUrl, ...runtimeOptions } = options",
  "export interface Forge3DRuntimeCapabilities",
  "export type ViewerStatus",
  "export interface OrbitView",
  "export interface Forge3DViewerOptions"
]) {
  assertIncludes(facade, expected, `facade must keep generated wasm bridge private: ${expected}`);
}

for (const expected of [
  "## Public API",
  "Declaration-only staging boundary",
  "## Frozen Viewer Defaults",
  "## Interaction And Automatic Redraw",
  "## Viewer Lifecycle And Recovery",
  "## Concurrency And Cleanup",
  "## Lifetime Rules",
  "## Error Codes",
  "Forge3DViewer.create(canvas, options)",
  "Forge3DRuntime.create(canvas, options)",
  "setTerrain(terrain)",
  "setTerrainFromSource(terrain)",
  "setCamera(camera)",
  "resize(size)",
  "screenshot()",
  "RUNTIME_DISPOSED",
  "RESOURCE_LIMIT_EXCEEDED",
  "Y-up",
  "arrows orbit",
  "Shift+arrows pan",
  "`+`/`-` zoom",
  "Home",
  "not independently",
  "initializing -> ready",
  "failed -> disposed",
  "one active terrain source load",
  "share one underlying capture",
  "onStatusChange",
  "onError",
  "same `Blob`",
  "schedules at most one",
  "animation frame",
  "successfully",
  "setView()",
  "resetView()",
  "also mark the viewer dirty",
  "getView()",
  "getCapabilities()",
  "getDiagnostics()",
  "defensive",
  "synchronous and idempotent",
  "ownedListeners",
  "activeObservers",
  "pendingAnimationFrame",
  "activeRuntimes"
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
