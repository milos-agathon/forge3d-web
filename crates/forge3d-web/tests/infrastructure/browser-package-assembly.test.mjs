import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
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
  buildSeleniumHarness,
} from "../../scripts/assemble-browser-package-artifact.mjs";
import { materializeSeleniumHarness } from "../../scripts/materialize-selenium-harness.mjs";
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
    "selenium-harness.tar.gz",
    "selenium-harness-lock.json",
    "materialize-selenium-harness.mjs",
    "browser-evidence.schema.json",
    "adapter-attestation.schema.json",
    "chr03-hardware-proof.schema.json",
    "chr04-hardware-proof.schema.json",
    "ffx03-hardware-proof.schema.json",
    "saf02-conformance.schema.json",
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
    "ffx03-hardware-proof-validator.mjs",
    "ffx03-lanes.mjs",
    "firefox-viewer.mjs",
    "saf02-conformance-validator.mjs",
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

test("Selenium closure assembly fails when a lock-bound installed package is missing", () => {
  const root = temporaryRoot();
  mkdirSync(join(root, "node_modules", "selenium-webdriver"), { recursive: true });
  writeFileSync(join(root, "package-lock.json"), JSON.stringify({ packages: {
    "node_modules/selenium-webdriver": { version: "4.35.0", integrity: "sha512-root", dependencies: { missing: "1" } },
  } }));
  writeFileSync(join(root, "node_modules", "selenium-webdriver", "package.json"),
    JSON.stringify({ name: "selenium-webdriver", version: "4.35.0" }));
  assert.throws(() => buildSeleniumHarness(root), /missing lock integrity for missing/u);
});

test("promoted Selenium closure materializes artifact-only and rejects missing or tampered inputs", () => {
  const root = temporaryRoot();
  const promotion = join(root, "promotion");
  const output = join(root, "materialized");
  mkdirSync(promotion);
  const harness = buildSeleniumHarness();
  const archiveName = "selenium-harness.tar.gz";
  const lockName = "selenium-harness-lock.json";
  const archiveSha256 = sha256(harness.archive);
  const lockBytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1, rootPackage: "selenium-webdriver",
    rootVersion: "4.35.0", archiveSha256, packages: harness.packages }, null, 2)}\n`);
  const acceptanceBytes = readFileSync(new URL("../webdriver/firefox-viewer.mjs", import.meta.url));
  const lanesBytes = readFileSync(new URL("../../scripts/ffx03-lanes.mjs", import.meta.url));
  writeFileSync(join(promotion, archiveName), harness.archive);
  writeFileSync(join(promotion, lockName), lockBytes);
  writeFileSync(join(promotion, "firefox-viewer.mjs"), acceptanceBytes);
  writeFileSync(join(promotion, "ffx03-lanes.mjs"), lanesBytes);
  writeFileSync(join(promotion, "browser-package-manifest.json"), JSON.stringify({ files: [
    { name: archiveName, sha256: archiveSha256 }, { name: lockName, sha256: sha256(lockBytes) },
    { name: "firefox-viewer.mjs", sha256: sha256(acceptanceBytes) },
    { name: "ffx03-lanes.mjs", sha256: sha256(lanesBytes) },
  ] }));
  const modulePath = materializeSeleniumHarness({ promotionDirectory: promotion, outputDirectory: output });
  assert.equal(modulePath, join(realpathSync(output), "node_modules", "selenium-webdriver", "index.js"));
  assert.doesNotThrow(() => readFileSync(modulePath));
  for (const name of ["firefox-viewer.mjs", "ffx03-lanes.mjs"]) copyFileSync(join(promotion, name), join(output, name));
  const acceptancePath = join(realpathSync(output), "firefox-viewer.mjs");
  assert.equal(execFileSync(process.execPath, ["--input-type=module", "--eval",
    `const module = await import(${JSON.stringify(pathToFileURL(acceptancePath).href)}); if (module.FFX03_SELENIUM_VERSION !== "4.35.0") throw new Error("wrong acceptance module");`], {
    cwd: root, encoding: "utf8", env: { PATH: process.env.PATH ?? "", NODE_PATH: "" },
  }), "");
  assert.doesNotThrow(() => readFileSync(join(promotion, "firefox-viewer.mjs")));
  assert.doesNotThrow(() => readFileSync(join(promotion, "ffx03-lanes.mjs")));

  rmSync(join(promotion, archiveName));
  assert.throws(() => materializeSeleniumHarness({ promotionDirectory: promotion,
    outputDirectory: join(root, "missing") }), /missing or tampered/u);
  writeFileSync(join(promotion, archiveName), Buffer.from("tampered"));
  assert.throws(() => materializeSeleniumHarness({ promotionDirectory: promotion,
    outputDirectory: join(root, "tampered") }), /missing or tampered/u);
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
