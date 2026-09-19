import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";
import { validateChr03HardwareProofContract } from "../../scripts/chr03-hardware-proof-validator.mjs";
import { validateChr04HardwareProofContract } from "../../scripts/chr04-hardware-proof-validator.mjs";
import { validChr03HardwareProof } from "./chr03-hardware-proof-fixture.mjs";
import { validChr04HardwareProof } from "./chr04-hardware-proof-fixture.mjs";
import { runViewerBenchmarkInBrowser } from "./viewer-benchmark-browser.js";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

test("transpiled benchmark wrapper imports its copied browser dependency and uses origin-root assets", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "forge3d-benchmark-module-"));
  try {
    const source = readFileSync(join(root, "tests/browser/viewer-benchmark.ts"), "utf8");
    writeFileSync(join(temporary, "viewer-benchmark.mjs"), ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
    }).outputText);
    copyFileSync(join(root, "tests/browser/viewer-benchmark-browser.js"), join(temporary, "viewer-benchmark-browser.js"));
    const module = await import(pathToFileURL(join(temporary, "viewer-benchmark.mjs")).href);
    assert.equal(typeof module.runViewerBenchmark, "function");
    assert.match(source, /new URL\("\/tests\/browser\/benchmark\/", page\.url\(\)\)/u);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("browser benchmark admits only HTTPS or loopback HTTP asset URLs", () => {
  const source = readFileSync(join(root, "tests/browser/viewer-benchmark-browser.js"), "utf8");
  assert.match(source, /url\.protocol === "https:"/u);
  assert.match(source, /"127\.0\.0\.1", "localhost", "\[::1\]"/u);
  assert.doesNotMatch(source, /startsWith\("https:\/\/"\)/u);
});

test("serialized benchmark callback retains its URL validation helper", async () => {
  const serialized = Function(`return (${runViewerBenchmarkInBrowser.toString()})`)();
  const previousWindow = globalThis.window;
  globalThis.window = { __forge3dInteractiveViewer: { canvas: {}, create: async () => { throw new Error("must not create"); } } };
  try {
    await assert.rejects(serialized({ environment: {}, assetUrls: {
      manifest: "file:///manifest.json", terrain: "http://example.com/terrain.bin", trace: "ftp://example.com/trace.json",
    } }), /HTTPS or loopback HTTP/u);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("benchmark viewer errors reach the shared hardware list and reject CHR-03 and CHR-04 proofs", async () => {
  const previousWindow = globalThis.window;
  const retainedErrors = [];
  globalThis.window = {
    __forge3dHardwareErrors: retainedErrors,
    __forge3dHardwareOnError: (error) => retainedErrors.push(error.code ?? error.message),
    __forge3dInteractiveViewer: {
      canvas: {},
      create: async ({ onError }) => {
        onError({ code: "GPU_DEVICE_LOST" });
        throw new Error("stop after injected benchmark error");
      },
    },
  };
  try {
    await assert.rejects(runViewerBenchmarkInBrowser({
      environment: {},
      assetUrls: {
        manifest: "https://fixture.test/manifest.json",
        terrain: "https://fixture.test/terrain.bin",
        trace: "https://fixture.test/trace.json",
      },
    }), /stop after injected benchmark error/u);
    assert.deepEqual(retainedErrors, ["GPU_DEVICE_LOST"]);
    for (const proof of [validChr03HardwareProof(), validChr04HardwareProof()]) {
      proof.errors = [...retainedErrors];
      const validate = proof.kind.includes("chr03")
        ? validateChr03HardwareProofContract
        : validateChr04HardwareProofContract;
      assert.throws(() => validate(proof), /more than 0 items|viewer errors/u);
    }
  } finally {
    globalThis.window = previousWindow;
  }
});
