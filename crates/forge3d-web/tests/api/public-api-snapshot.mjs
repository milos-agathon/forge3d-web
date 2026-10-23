import { verifyDeclarationContract } from "../../scripts/declaration-contract.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const typesPath = join(root, "types", "index.d.ts");
const docsPath = join(root, "docs", "browser-api.md");

const types = readText(typesPath);
const docs = readText(docsPath);

verifyDeclarationContract({root});

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
  "## Public API",
  "## Interactive Viewer API",
  "implements the frozen high-level surface",
  "The facade loads `wasmUrl`",
  "FND-01",
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
  "code completion alone is not",
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
  "ownedAnimationFrameCount",
  "activeRuntimes",
  "## Lights, Materials, Textures, IBL, And Shadows",
  "resolveBrdfModel",
  "effectiveQuality",
  "csm is a cascade pipeline, not a shadow filter",
  "CascadedShadowConfig",
  "IblCache",
  "renderMode: \"screen\"",
  "## Cameras, Controllers, Animation, And Rigs",
  "orthographicHeight",
  "clipSpace",
  "worldToScreen",
  "screenRay",
  "CameraController",
  "FlyController",
  "KeyV",
  "replayCameraInput",
  "CameraAnimation",
  "Catmull-Rom",
  "TerrainOrbitRig",
  "TerrainRailRig",
  "TerrainTargetFollowRig",
  "minimumHeight",
  "w05-camera-native.json"
]) {
  assertIncludes(docs, expected, `browser API docs missing: ${expected}`);
}

const currentRuntimeSurface = sectionBetween(
  docs,
  "`Forge3DRuntime` remains the low-level immediate-render primitive.",
  "## Interactive Viewer API",
);
assertIncludes(
  currentRuntimeSurface,
  "getCapabilities",
  "current runtime surface must document getCapabilities",
);

function readText(path) {
  return readFileSync(path, "utf8");
}

function sectionBetween(text, start, end) {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) {
    throw new Error(`missing documentation section boundary: ${start} -> ${end}`);
  }
  return text.slice(startIndex, endIndex);
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
