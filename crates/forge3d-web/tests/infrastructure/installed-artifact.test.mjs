import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createInstalledArtifact, attachInstalledSuite, verifyInstalledArtifact } from "../../scripts/installed-artifact.mjs";

test("installed suites share verified bytes and reject dirty, changed, or incomplete artifacts", () => {
  const temp = mkdtempSync(join(tmpdir(), "artifact-contract-"));
  const root = join(temp, "source"), manifest = join(temp, "artifact/manifest.json");
  mkdirSync(root);
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "artifact-fixture", version: "1.0.0", files: ["dist", "types"], scripts: { build: "node build.cjs" } }));
    writeFileSync(join(root, ".gitignore"), "dist/\ntypes/\n");
    writeFileSync(join(root, "build.cjs"), `const fs=require('node:fs');fs.mkdirSync('dist',{recursive:true});fs.mkdirSync('types',{recursive:true});fs.writeFileSync('dist/index.js','module.exports=42;');fs.writeFileSync('dist/forge3d_web_bg.wasm',Buffer.from([0,97,115,109]));fs.writeFileSync('types/index.d.ts','export {};');`);
    git("init"); git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture");
    const artifact = createInstalledArtifact(root, manifest);
    for (const suite of ["first", "second"]) {
      const consumer = join(temp, suite);
      const attached = attachInstalledSuite({ packageRoot: root, consumer, suite, artifactPath: manifest });
      assert.equal(attached.packageSha256, artifact.packageSha256);
      assert.equal(readFileSync(join(consumer, "node_modules/artifact-fixture/dist/index.js"), "utf8"), "module.exports=42;");
    }
    const records = readFileSync(join(temp, "artifact/suites.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(records.map(r=>r.suite), ["first", "second"]);
    assert.equal(new Set(records.map(r=>r.packageSha256)).size, 1);
    writeFileSync(join(root, "dirty.txt"), "uncommitted");
    assert.throws(()=>verifyInstalledArtifact(manifest, root), /clean committed[\s\S]*\?\? dirty\.txt/);
    assert.throws(()=>createInstalledArtifact(root, join(temp,"dirty/manifest.json")), /clean committed/);
    rmSync(join(root,"dirty.txt"));
    const bytes = readFileSync(artifact.tarball);
    writeFileSync(artifact.tarball, "changed");
    assert.throws(()=>verifyInstalledArtifact(manifest, root), /digest mismatch/);
    writeFileSync(artifact.tarball, bytes);
    rmSync(join(artifact.installed,"dist/index.js"));
    assert.throws(()=>verifyInstalledArtifact(manifest, root), /ENOENT/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("post-build cleanliness failure identifies changed inputs without publishing a manifest", () => {
  const temp = mkdtempSync(join(tmpdir(), "artifact-dirty-build-"));
  const root = join(temp, "source"), manifest = join(temp, "artifact/manifest.json");
  mkdirSync(root);
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { build: "node build.cjs" } }));
    writeFileSync(join(root, "generated.d.ts"), "export type Value = string;\n");
    writeFileSync(join(root, "build.cjs"), "require('node:fs').writeFileSync('generated.d.ts', 'export type Value = number;\\n');");
    for (const args of [["init"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"]]) {
      const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    }
    assert.throws(() => createInstalledArtifact(root, manifest), error => {
      assert.match(error.message, /clean committed[\s\S]* M generated\.d\.ts/);
      assert.match(error.message, /Tracked diff:[\s\S]*generated\.d\.ts.*2/);
      return true;
    });
    assert.equal(existsSync(manifest), false);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
