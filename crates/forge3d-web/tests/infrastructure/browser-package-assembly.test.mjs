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
import { pathToFileURL } from "node:url";
import test, { afterEach } from "node:test";
import { createHash } from "node:crypto";

import {
  assembleBrowserPackageArtifact,
  assertNoWorkspaceDependencies,
  createTarGz,
} from "../../scripts/assemble-browser-package-artifact.mjs";
import { validChr03HardwareProof } from "../browser/chr03-hardware-proof-fixture.mjs";
import { validSaf02Conformance } from "../browser/saf02-conformance-fixture.mjs";

const temporaryRoots = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("assembly binds one tarball, clean exact HEAD, evidence, schemas, and fixture", async () => {
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
    "chr03-hardware-proof.schema.json",
    "chr04-hardware-proof.schema.json",
    "saf02-conformance.schema.json",
    "saf04-hardware-proof.schema.json",
    "host-inventory.schema.json",
    "mobile-device-route-readiness.schema.json",
    "commit-metadata.json",
    "source-tree-status.json",
    "browser-package-manifest.json",
    "create-browser-matrix-record.mjs",
    "canonical-json.mjs",
    "browser-lane-runtime.mjs",
    "browser-launch-provenance.mjs",
    "browser-run-provenance.mjs",
    "browser-session-runtime.mjs",
    "chrome-hardware-acceptance.mjs",
    "edge-browser-acceptance.mjs",
    "chr03-hardware-proof-validator.mjs",
    "chr03-lanes.mjs",
    "chr04-hardware-proof-validator.mjs",
    "chr04-lanes.mjs",
    "saf02-conformance-validator.mjs",
    "saf04-hardware-proof-validator.mjs",
    "safari-browser-acceptance.mjs",
    "json-schema-validator.mjs",
    "browser-process-registry.mjs",
    "capture-trackpad-inventory.mjs",
    "webdriver-client.mjs",
    "probe-mobile-device-routes.mjs",
    "manage-browser-route.mjs",
    "manage-browser-update-window.mjs",
    "cleanup-browser-hardware.mjs",
    "appium-session.mjs",
    "browser-policy.json",
    "https-origin-policy.json",
    "hardware-matrix.json",
    "device-matrix.json",
  ]) {
    assert.equal(manifest.files.some((entry) => entry.name === name), name !== "browser-package-manifest.json");
    assert.doesNotThrow(() => readFileSync(join(output, name)));
  }
  const sessionModule = await import(pathToFileURL(join(output, "browser-session-runtime.mjs")).href);
  assert.equal(typeof sessionModule.openProductionSession, "function");
  const proofModule = await import(pathToFileURL(join(output, "chr03-hardware-proof-validator.mjs")).href);
  const proof = validChr03HardwareProof();
  assert.equal(proofModule.validateChr03HardwareProofContract(proof), proof);
  proof.systemInfo.available = "false";
  assert.throws(() => proofModule.validateChr03HardwareProofContract(proof), /expected type boolean/u);
  const safariModule = await import(pathToFileURL(join(output, "saf02-conformance-validator.mjs")).href);
  const safariProof = validSaf02Conformance();
  const safariExpected = {
    ...safariProof.binding,
    applicationUrl: `${safariProof.route.applicationOrigin}${safariProof.route.basePath}`,
    assetUrl: `${safariProof.route.assetOrigin}${safariProof.route.basePath}`,
    effectiveLaunchArguments: [],
  };
  assert.equal(safariModule.validateSaf02Conformance(safariProof, safariExpected), safariProof);
  safariProof.render.changedPixels = 100;
  assert.throws(() => safariModule.validateSaf02Conformance(safariProof, safariExpected));
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
