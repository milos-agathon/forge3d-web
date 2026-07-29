import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import { createHash } from "node:crypto";

import {
  assembleBrowserPackageArtifact,
  assertNoWorkspaceDependencies,
  createTarGz,
} from "../../scripts/assemble-browser-package-artifact.mjs";

const temporaryRoots = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("assembly binds one tarball, clean exact HEAD, evidence, schemas, and fixture", () => {
  const root = temporaryRoot();
  const repository = join(root, "repository");
  const evidence = join(repository, "ignored", "evidence");
  const output = join(repository, "ignored", "output");
  mkdirSync(repository, { recursive: true });
  writeFileSync(join(repository, ".gitignore"), "ignored/\n");
  writeFileSync(join(repository, "tracked.txt"), "exact source\n");
  git(repository, ["init", "-b", "main"]);
  git(repository, ["add", ".gitignore", "tracked.txt"]);
  git(repository, [
    "-c",
    "user.name=Forge3D Test",
    "-c",
    "user.email=test@forge3d.dev",
    "commit",
    "-m",
    "fixture",
  ]);
  const targetSha = git(repository, ["rev-parse", "HEAD"]);
  mkdirSync(join(evidence, "npm", "package"), { recursive: true });
  writeFileSync(
    join(evidence, "npm", "package", "package.json"),
    JSON.stringify({
      name: "@forge3d/web",
      version: "1.26.3",
      dependencies: { safe: "^1.0.0" },
    }),
  );
  const tarball = createTarGz(join(evidence, "npm"));
  const tarballName = "forge3d-web-1.26.3.tgz";
  const packageSha256 = sha256(tarball);
  mkdirSync(join(evidence, "consumer-fixture", "tests"), { recursive: true });
  writeFileSync(join(evidence, tarballName), tarball);
  writeFileSync(
    join(evidence, "package-evidence.json"),
    JSON.stringify({
      commit: targetSha,
      tarball: tarballName,
      packageSha256,
    }),
  );
  writeFileSync(
    join(evidence, "browser-gate.json"),
    JSON.stringify({
      sourceRevision: { commit: targetSha },
      artifact: { sha256: packageSha256 },
    }),
  );
  writeFileSync(
    join(evidence, "consumer-fixture", "package.json"),
    '{"private":true}',
  );
  writeFileSync(
    join(evidence, "consumer-fixture", "tests", "harness.mjs"),
    "export {};",
  );

  const manifest = assembleBrowserPackageArtifact({
    evidenceDirectory: evidence,
    outputDirectory: output,
    targetSha,
    workflowSha: targetSha,
    repositoryRootPath: repository,
  });
  assert.equal(manifest.targetSha, targetSha);
  assert.equal(manifest.packageSha256, packageSha256);
  assert.equal(
    readFileSync(join(output, `${tarballName}.sha256`), "utf8"),
    `${packageSha256}  ${tarballName}\n`,
  );
  for (const name of [
    "consumer-fixture.tar.gz",
    "browser-evidence.schema.json",
    "adapter-attestation.schema.json",
    "commit-metadata.json",
    "source-tree-status.json",
    "browser-package-manifest.json",
    "create-browser-matrix-record.mjs",
    "canonical-json.mjs",
  ]) {
    assert.equal(manifest.files.some((entry) => entry.name === name), name !== "browser-package-manifest.json");
    assert.doesNotThrow(() => readFileSync(join(output, name)));
  }
});

test("assembly dependency guard rejects file, link, and workspace protocols", () => {
  for (const value of ["file:../package", "link:../package", "workspace:*"]) {
    assert.throws(
      () =>
        assertNoWorkspaceDependencies({
          dependencies: { forbidden: value },
        }),
      /prohibited workspace dependency/u,
    );
  }
});

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "forge3d-package-assembly-"));
  temporaryRoots.push(root);
  return root;
}

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
