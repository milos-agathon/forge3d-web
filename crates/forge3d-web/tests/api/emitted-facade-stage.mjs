import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const temp = mkdtempSync(join(tmpdir(), "forge3d-fnd00-facade-"));
const emittedPath = join(temp, "index.mjs");
const source = readFileSync(join(root, "src-ts", "index.ts"), "utf8");
const emitted = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
  },
  fileName: "index.ts",
});
writeFileSync(emittedPath, emitted.outputText);

try {
  const facade = await import(pathToFileURL(emittedPath));

  assert.deepEqual(
    Object.keys(facade).sort(),
    ["Forge3DError", "Forge3DRuntime"],
    "FND-00 must remain an explicit declaration-only stage",
  );
  assert.equal(
    facade.Forge3DViewer,
    undefined,
    "Forge3DViewer must not be claimed as an emitted runtime export before implementation",
  );
  assert.equal(
    facade.Forge3DRuntime.prototype.getCapabilities,
    undefined,
    "getCapabilities must not be claimed as implemented before its runtime task lands",
  );

  await assert.rejects(
    facade.Forge3DRuntime.create({}, { wasmUrl: "custom.wasm" }),
    (error) =>
      error instanceof facade.Forge3DError &&
      error.code === "WASM_LOAD_FAILED" &&
      error.message.includes("declaration-only"),
    "custom wasmUrl must fail explicitly instead of reaching Rust as an unknown field",
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
