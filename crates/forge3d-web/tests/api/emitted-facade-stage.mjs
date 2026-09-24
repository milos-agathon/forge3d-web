import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import ts from "typescript";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const temp = mkdtempSync(join(tmpdir(), "forge3d-facade-"));
// Emitted modules import runtime dependencies (ktx-parse) by bare specifier;
// resolve them from the package's installed dependencies like a consumer would.
symlinkSync(join(root, "node_modules"), join(temp, "node_modules"), "junction");

try {
  const facadeAPath = emitFacadeCopy("copy-a");
  const facadeBPath = emitFacadeCopy("copy-b");
  const facadeA = await import(pathToFileURL(facadeAPath));
  const facadeB = await import(pathToFileURL(facadeBPath));
  const internalsA = await import(
    pathToFileURL(join(dirname(facadeAPath), "runtime-internals.js"))
  );

  assert.deepEqual(
    Object.keys(facadeA).sort(),
    [
      "AOV_ID_BACKGROUND",
      "AOV_ID_SCENE_NODE_BASE",
      "AOV_ID_TERRAIN",
      "AovFrame",
      "BorrowedWasmView",
      "Camera",
      "CameraAnimation",
      "CameraController",
      "CameraKeyframe",
      "CascadedShadowConfig",
      "DEFAULT_CAMERA_KEY_BINDINGS",
      "DenoiseSettings",
      "EXR_MIME_TYPE",
      "FlyController",
      "Forge3DError",
      "Forge3DMessageClient",
      "Forge3DOffscreenRenderer",
      "Forge3DRuntime",
      "Forge3DScene",
      "Forge3DSession",
      "Forge3DViewer",
      "Forge3DWebSocketAdapter",
      "Forge3DWorkerPool",
      "Forge3DWorkerRenderer",
      "Frame",
      "FrameDumper",
      "HdrFrame",
      "IblCache",
      "ImageBasedLighting",
      "Ktx2Loader",
      "LightCollection",
      "MaterialCollection",
      "OfflineProgress",
      "OfflineQualitySettings",
      "OrbitController",
      "RenderConfig",
      "RenderProgress",
      "RendererConfig",
      "ShadowConfig",
      "TERRAIN_CLEARANCE_TOLERANCE",
      "TerrainClearance",
      "TerrainDataset",
      "TerrainOrbitRig",
      "TerrainRailRig",
      "TerrainRigSource",
      "TerrainTargetFollowRig",
      "TextureSet",
      "aovObjectId",
      "apertureToFStop",
      "atrousDenoise",
      "cameraDirection",
      "cameraDofParams",
      "cameraStateEye",
      "cameraStateToInput",
      "circleOfConfusion",
      "compareImages",
      "composeTrs",
      "createDownloadFrameSink",
      "createFrameStream",
      "createMemoryFrameSink",
      "createNotebookAdapter",
      "createOpfsFrameSink",
      "createTerrainDatasetWorkerHandler",
      "cubicHermite",
      "decodeRgbe",
      "defineForge3DElement",
      "depthOfFieldRange",
      "dumpFrameSequence",
      "encodePng",
      "encodeVideo",
      "extractGltfMaterialChannels",
      "fStopToAperture",
      "frameTimestampUs",
      "generateMeshTangents",
      "getLightPreset",
      "getRendererPreset",
      "getTerrainColormap",
      "getTerrainColormapLut",
      "hasUpwardConvergenceTrend",
      "hyperfocalDistance",
      "installForge3DWorkerHost",
      "invertMatrix",
      "lightPresetNames",
      "lookAt",
      "lookAtTransform",
      "makeCamera",
      "mat4FromRows",
      "mat4ToRows",
      "multiplyMatrices",
      "muxEncodedVideo",
      "normalMatrix",
      "orthographic",
      "perspective",
      "probeVideoCodecs",
      "readByteSource",
      "readExr",
      "renderFrames",
      "renderOffline",
      "rendererPresetNames",
      "replayCameraInput",
      "resolveBrdfModel",
      "rotateX",
      "rotateY",
      "rotateZ",
      "scale",
      "scaleUniform",
      "screenRay",
      "screenToWorld",
      "selectWorkerExecutionMode",
      "serveForge3DMessagePort",
      "terrainRigFromJSON",
      "translate",
      "viewProjection",
      "viewerOrbitRadius",
      "worldToScreen",
      "writeByteSink",
      "writeExr",
      "writeFrames",
      "yawPitchFromDirection",
    ],
    "the implemented facade must export the frozen runtime, viewer, scene, session, and config surface",
  );
  // W05 camera math runs from the emitted package without WebGPU or WASM.
  assert.deepEqual(Array.from(facadeA.translate(1, 2, 3)).slice(12, 15), [1, 2, 3]);
  assert.equal(
    new facadeA.CameraAnimation([
      { time: 0, phiDeg: 0, thetaDeg: 45, radius: 10, fovDeg: 50 },
      { time: 1, phiDeg: 90, thetaDeg: 45, radius: 10, fovDeg: 50 },
    ]).getFrameCount(30),
    31,
  );
  assert.equal(new facadeA.CameraController().mode, "orbit");
  assert.equal(
    typeof facadeA.Forge3DRuntime.prototype.getCapabilities,
    "function",
    "getCapabilities must be implemented by the facade",
  );

  for (const forbidden of [
    "setDeviceLostHandler",
    "simulateDeviceLossForTesting",
  ]) {
    assert.equal(
      forbidden in facadeA.Forge3DRuntime.prototype,
      false,
      `${forbidden} must not leak through the shipped facade prototype`,
    );
  }
  assert.equal(
    facadeA.Forge3DError.from({ code: "future-code", message: "unknown" }).code,
    "INTERNAL_ERROR",
    "unknown generated-WASM errors must fail closed as INTERNAL_ERROR",
  );

  let fetchCount = 0;
  let initCount = 0;
  globalThis.__forge3dTestInit = () => {
    initCount += 1;
  };
  let rejectStaleFetch;
  globalThis.fetch = () => {
    fetchCount += 1;
    return new Promise((_resolve, reject) => {
      rejectStaleFetch = reject;
    });
  };
  const stale = facadeA.Forge3DRuntime.create({}, {
    wasmUrl: "https://assets.example.test/stale.wasm",
  });
  await Promise.resolve();
  const coordinator =
    globalThis[Symbol.for("@forge3d/web.wasm-bridge-coordinator")];
  const replacementPromise = Promise.resolve({});
  coordinator.record = {
    selectedUrl: "https://assets.example.test/newer.wasm",
    promise: replacementPromise,
    state: "ready",
  };
  rejectStaleFetch(new Error("stale initialization failed"));
  await assert.rejects(stale, (error) => error.code === "WASM_LOAD_FAILED");
  assert.equal(
    coordinator.record.promise,
    replacementPromise,
    "a stale rejection must not clear a newer coordinator record",
  );
  delete coordinator.record;
  fetchCount = 0;

  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response("missing", {
      status: 404,
      headers: { "content-type": "text/plain" },
    });
  };
  await assert.rejects(
    facadeA.Forge3DRuntime.create({}, {
      wasmUrl: "https://assets.example.test/failed.wasm",
    }),
    (error) =>
      error instanceof facadeA.Forge3DError &&
      error.code === "WASM_LOAD_FAILED",
    "an owning WASM failure must be normalized",
  );
  assert.equal(fetchCount, 1);

  let releaseFetch;
  globalThis.fetch = () => {
    fetchCount += 1;
    return new Promise((resolve) => {
      releaseFetch = resolve;
    });
  };
  const selectedUrl = "https://assets.example.test/forge3d.wasm#ignored";
  const first = facadeA.Forge3DRuntime.create({}, { wasmUrl: selectedUrl });
  const second = facadeB.Forge3DRuntime.create({}, {
    wasmUrl: "https://assets.example.test/forge3d.wasm",
  });
  await assert.rejects(
    facadeB.Forge3DRuntime.create({}, {
      wasmUrl: "https://assets.example.test/different.wasm",
    }),
    (error) =>
      error instanceof facadeB.Forge3DError &&
      error.code === "INVALID_INPUT",
    "a different URL must reject while the realm coordinator is pending",
  );
  assert.equal(fetchCount, 2, "duplicate bundles must perform one shared fetch");
  releaseFetch(
    new Response(new Uint8Array([0, 97, 115, 109]), {
      status: 200,
      headers: { "content-type": "application/wasm; charset=binary" },
    }),
  );
  const [runtimeA, runtimeB] = await Promise.all([first, second]);
  assert.equal(initCount, 1, "duplicate bundles must initialize WASM once");
  assert.equal(runtimeA.getCapabilities().deviceState, "ready");
  assert.equal(runtimeB.getCapabilities().surfaceFormat, "bgra8unorm-srgb");

  const capabilitiesA = runtimeA.getCapabilities();
  capabilitiesA.adapterInfo.name = "mutated";
  capabilitiesA.features.push("mutated");
  capabilitiesA.limits.maxBindGroups = 1;
  capabilitiesA.surfaceFormats.push("mutated");
  const capabilitiesAgain = runtimeA.getCapabilities();
  assert.equal(
    capabilitiesAgain.adapterInfo.name,
    "fake-adapter",
    "adapter info must be a defensive copy",
  );
  assert.equal(
    capabilitiesAgain.features.includes("mutated"),
    false,
    "features must be a defensive copy",
  );
  assert.equal(capabilitiesAgain.limits.maxBindGroups, 4);
  assert.equal(
    capabilitiesAgain.surfaceFormats.includes("mutated"),
    false,
    "surface formats must be a defensive copy",
  );
  const nativeStats = runtimeA.getRenderStats();
  assert.equal(nativeStats.passes[0].timing, "gpu-timestamp");
  nativeStats.passes.length = 0;
  assert.equal(
    runtimeA.getRenderStats().passes.length,
    1,
    "render stats must be a defensive copy",
  );
  const nativeMemory = runtimeA.getMemoryReport();
  nativeMemory.categories["scene:vertices"] = 1;
  assert.equal(
    runtimeA.getMemoryReport().categories["scene:vertices"],
    undefined,
    "memory categories must be a defensive copy",
  );
  runtimeA.setScene({ id: "scene", nodes: [], passes: [] });
  const facadeRgba = await runtimeA.readRgba();
  assert.equal(facadeRgba.length, 4);
  assert.equal(
    fetchCount,
    2,
    "the prior owning failure must release the coordinator for exactly one retry",
  );

  await assert.rejects(
    facadeA.Forge3DRuntime.create({}, {
      wasmUrl: "https://assets.example.test/other-after-ready.wasm",
    }),
    (error) => error?.code === "INVALID_INPUT",
    "a different URL must also reject after the coordinator is ready",
  );
  assert.equal(fetchCount, 2);

  globalThis.__forge3dTestSynchronousRegistrationLoss = true;
  const earlyLoss = await facadeA.Forge3DRuntime.create({}, {
    wasmUrl: "https://assets.example.test/forge3d.wasm",
  });
  const earlyEvents = [];
  const earlyHandler = (error) => {
    earlyEvents.push(error.code);
    internalsA.setRuntimeDeviceLostHandler(earlyLoss, earlyHandler);
  };
  internalsA.setRuntimeDeviceLostHandler(earlyLoss, earlyHandler);
  internalsA.setRuntimeDeviceLostHandler(earlyLoss, earlyHandler);
  assert.deepEqual(
    earlyEvents,
    ["DEVICE_LOST"],
    "a synchronous registration loss must survive construction and replay once",
  );
  earlyLoss.dispose();

  const disposedBeforeHandler = await facadeA.Forge3DRuntime.create({}, {
    wasmUrl: "https://assets.example.test/forge3d.wasm",
  });
  disposedBeforeHandler.dispose();
  let disposedEvents = 0;
  internalsA.setRuntimeDeviceLostHandler(disposedBeforeHandler, () => {
    disposedEvents += 1;
  });
  assert.equal(
    disposedEvents,
    0,
    "disposal before handler registration must clear the pending loss",
  );
  globalThis.__forge3dTestSynchronousRegistrationLoss = false;
  globalThis.__forge3dTestCallbackCount = 0;

  runtimeA.dispose();
  assert.equal(runtimeA.getCapabilities().deviceState, "disposed");

  const detachBeforeOrdinaryDispose = globalThis.__forge3dTestDetachCount;
  const nativeDisposeBeforeOrdinaryDispose = globalThis.__forge3dTestNativeDisposeCount;
  const ordinary = await facadeA.Forge3DRuntime.create({}, {
    wasmUrl: "https://assets.example.test/forge3d.wasm",
  });
  ordinary.dispose();
  ordinary.dispose();
  assert.equal(
    globalThis.__forge3dTestDetachCount,
    detachBeforeOrdinaryDispose + 1,
    "ordinary disposal must detach the native loss listener synchronously once",
  );
  assert.equal(
    globalThis.__forge3dTestNativeDisposeCount,
    nativeDisposeBeforeOrdinaryDispose + 1,
    "ordinary disposal must finalize the native runtime once",
  );

  let settleScreenshot;
  globalThis.__forge3dTestScreenshot = new Promise((resolve) => {
    settleScreenshot = resolve;
  });
  const pending = await facadeB.Forge3DRuntime.create({}, {
    wasmUrl: "https://assets.example.test/forge3d.wasm",
  });
  const pendingNative = globalThis.__forge3dTestNativeRuntimes.at(-1);
  const pendingScreenshot = pending.screenshot();
  const detachBeforePendingDispose = globalThis.__forge3dTestDetachCount;
  const nativeDisposeBeforePendingDispose = globalThis.__forge3dTestNativeDisposeCount;
  pending.dispose();
  assert.equal(
    globalThis.__forge3dTestDetachCount,
    detachBeforePendingDispose + 1,
    "pending screenshot disposal must detach without waiting for native finalization",
  );
  assert.equal(pendingNative.callback, undefined);
  pendingNative.emitLoss();
  assert.equal(globalThis.__forge3dTestCallbackCount, 0);
  assert.equal(
    globalThis.__forge3dTestNativeDisposeCount,
    nativeDisposeBeforePendingDispose,
    "native disposal must wait for the in-flight screenshot",
  );
  assert.equal(pending.getCapabilities().deviceState, "disposed");
  settleScreenshot(new Blob([]));
  await assert.rejects(
    pendingScreenshot,
    (error) => error?.code === "RUNTIME_DISPOSED",
  );
  await Promise.resolve();
  assert.equal(
    globalThis.__forge3dTestNativeDisposeCount,
    nativeDisposeBeforePendingDispose + 1,
    "the settled screenshot must finalize native disposal exactly once",
  );
  pendingNative.emitLoss();
  assert.equal(globalThis.__forge3dTestCallbackCount, 0);
  delete globalThis.__forge3dTestScreenshot;

  const incompatible = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
        Object.defineProperty(globalThis, Symbol.for("@forge3d/web.wasm-bridge-coordinator"), {
          value: { schemaVersion: 99 },
          configurable: false
        });
        const facade = await import(${JSON.stringify(pathToFileURL(facadeAPath).href)});
        try {
          await facade.Forge3DRuntime.create({}, {
            wasmUrl: "https://assets.example.test/never-fetched.wasm"
          });
          process.exitCode = 2;
        } catch (error) {
          if (error?.code !== "INTERNAL_ERROR") process.exitCode = 3;
        }
      `,
    ],
    { encoding: "utf8" },
  );
  assert.equal(
    incompatible.status,
    0,
    `incompatible coordinator must fail closed: ${incompatible.stderr}`,
  );
} finally {
  delete globalThis.__forge3dTestInit;
  delete globalThis.__forge3dTestScreenshot;
  delete globalThis.__forge3dTestNativeRuntimes;
  delete globalThis.__forge3dTestDetachCount;
  delete globalThis.__forge3dTestNativeDisposeCount;
  delete globalThis.__forge3dTestCallbackCount;
  delete globalThis.__forge3dTestSynchronousRegistrationLoss;
  // Remove the dependency junction itself so recursive cleanup never follows it.
  unlinkSync(join(temp, "node_modules"));
  rmSync(temp, { recursive: true, force: true });
}

function emitFacadeCopy(name) {
  const copyRoot = join(temp, name);
  mkdirSync(copyRoot, { recursive: true });
  for (const file of readdirSync(join(root, "src-ts"))) {
    if (!file.endsWith(".ts")) continue;
    const source = readFileSync(join(root, "src-ts", file), "utf8");
    const emitted = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ES2022,
      },
      fileName: file,
    });
    writeFileSync(
      join(copyRoot, file.replace(/\.ts$/, ".js")),
      emitted.outputText,
    );
  }
  const fakeBridge = `
    export class Forge3DRuntime {
      static async create() {
        const runtime = new Forge3DRuntime();
        (globalThis.__forge3dTestNativeRuntimes ??= []).push(runtime);
        return runtime;
      }
      static async createOffscreen() {
        const runtime = new Forge3DRuntime();
        (globalThis.__forge3dTestNativeRuntimes ??= []).push(runtime);
        return runtime;
      }
      disposed = false;
      width = 64;
      height = 64;
      diagnosticsEnabled = false;
      capabilities = {
        maxTextureDimension2D: 4096,
        maxBufferSize: 1073741824,
        surfaceFormat: "bgra8unorm-srgb",
        adapterInfo: {
          name: "fake-adapter",
          vendor: "0x1234",
          architecture: "",
          device: "0x5678",
          description: "fake driver",
          backend: "webgpu",
          deviceType: "discrete-gpu"
        },
        isFallbackAdapter: false,
        features: ["timestamp-query"],
        limits: { maxTextureDimension2D: 4096, maxBindGroups: 4 },
        surfaceFormats: ["rgba8unorm", "bgra8unorm-srgb"],
        preferredCanvasFormat: "bgra8unorm-srgb",
        timestampQuery: true
      };
      clearColor() { return [0, 0, 0, 1]; }
      getCapabilities() {
        return {
          ...this.capabilities,
          deviceState: this.disposed ? "disposed" : "ready"
        };
      }
      getRenderStats() {
        return {
          frameIndex: 1,
          frameTimeMs: 1,
          drawCalls: 1,
          triangles: 2,
          passes: [{ name: "terrain", milliseconds: 1, timing: "gpu-timestamp" }]
        };
      }
      getMemoryReport() {
        return {
          currentBytes: 0,
          peakBytes: 1024,
          budgetBytes: 536870912,
          utilization: 0,
          allocationCount: 0,
          categories: {},
          effectiveQuality: "high",
          downgrades: []
        };
      }
      setScene(scene) { this.scene = scene; }
      async readRgba() { return new Uint8Array([1, 2, 3, 255]); }
      setDeviceLostCallback(callback) { this.callback = callback; }
      registerDeviceLostCallback(callback) {
        this.callback = (error) => {
          globalThis.__forge3dTestCallbackCount += 1;
          callback(error);
        };
        if (globalThis.__forge3dTestSynchronousRegistrationLoss) {
          this.callback({ code: "DEVICE_LOST", message: "synchronous registration loss" });
        }
        let active = true;
        return () => {
          if (!active) return;
          active = false;
          globalThis.__forge3dTestDetachCount += 1;
          this.callback = undefined;
        };
      }
      emitLoss() { this.callback?.({ code: "DEVICE_LOST", message: "test loss" }); }
      setTerrain() {}
      async setTerrainFromSource() {}
      setCamera() {}
      resize() {}
      render() {}
      async screenshot() {
        return globalThis.__forge3dTestScreenshot ?? new Blob([]);
      }
      dispose() {
        if (this.disposed) return;
        this.disposed = true;
        globalThis.__forge3dTestNativeDisposeCount += 1;
      }
    }
    export default async function init({ module_or_path: response }) {
      if (!(response instanceof Response)) throw new Error("expected Response");
      globalThis.__forge3dTestInit?.();
    }
  `;
  mkdirSync(join(temp, "pkg"), { recursive: true });
  globalThis.__forge3dTestNativeRuntimes = [];
  globalThis.__forge3dTestDetachCount = 0;
  globalThis.__forge3dTestNativeDisposeCount = 0;
  globalThis.__forge3dTestCallbackCount = 0;
  writeFileSync(join(temp, "pkg", "forge3d_web.js"), fakeBridge);
  writeFileSync(join(temp, "package.json"), '{"type":"module"}');
  return join(copyRoot, "index.js");
}
