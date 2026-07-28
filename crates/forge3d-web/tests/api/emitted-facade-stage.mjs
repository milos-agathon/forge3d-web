import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import ts from "typescript";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const temp = mkdtempSync(join(tmpdir(), "forge3d-facade-"));

try {
  const facadeAPath = emitFacadeCopy("copy-a");
  const facadeBPath = emitFacadeCopy("copy-b");
  const facadeA = await import(pathToFileURL(facadeAPath));
  const facadeB = await import(pathToFileURL(facadeBPath));

  assert.deepEqual(
    Object.keys(facadeA).sort(),
    ["Forge3DError", "Forge3DRuntime", "Forge3DViewer"],
    "the implemented facade must export the frozen runtime and viewer classes",
  );
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
  runtimeA.dispose();
  assert.equal(runtimeA.getCapabilities().deviceState, "disposed");

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
      static async create() { return new Forge3DRuntime(); }
      disposed = false;
      width = 64;
      height = 64;
      diagnosticsEnabled = false;
      clearColor() { return [0, 0, 0, 1]; }
      getCapabilities() {
        return {
          deviceState: this.disposed ? "disposed" : "ready",
          maxTextureDimension2D: 4096,
          maxBufferSize: 1073741824,
          surfaceFormat: "bgra8unorm-srgb"
        };
      }
      setDeviceLostCallback(callback) { this.callback = callback; }
      setTerrain() {}
      async setTerrainFromSource() {}
      setCamera() {}
      resize() {}
      render() {}
      async screenshot() { return new Blob([]); }
      dispose() { this.disposed = true; }
    }
    export default async function init({ module_or_path: response }) {
      if (!(response instanceof Response)) throw new Error("expected Response");
      globalThis.__forge3dTestInit?.();
    }
  `;
  mkdirSync(join(temp, "pkg"), { recursive: true });
  writeFileSync(join(temp, "pkg", "forge3d_web.js"), fakeBridge);
  writeFileSync(join(temp, "package.json"), '{"type":"module"}');
  return join(copyRoot, "index.js");
}
