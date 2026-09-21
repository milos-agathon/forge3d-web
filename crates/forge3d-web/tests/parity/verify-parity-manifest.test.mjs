import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolve } from "node:path";

import {
  ParityVerificationError,
  loadParityFiles,
  verifyParityData,
} from "../../../../scripts/verify-parity-manifest.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..", "..", "..", "..");

function cleanData() {
  const loaded = loadParityFiles(repositoryRoot);
  return {
    ...structuredClone({
      manifest: loaded.manifest,
      schema: loaded.schema,
      inventory: loaded.inventory,
      fixtureContracts: loaded.fixtureContracts,
      hardwareProfiles: loaded.hardwareProfiles,
      dependencyLock: loaded.dependencyLock,
    }),
    digestErrors: [...loaded.digestErrors],
    consumerRecords: [],
  };
}

function expectFailure(data, bucket, pattern) {
  assert.throws(
    () => verifyParityData(data),
    (error) => {
      assert(error instanceof ParityVerificationError);
      assert(error.report[bucket].some((message) => pattern.test(message)), `${bucket} did not contain ${pattern}:\n${error.message}`);
      return true;
    },
  );
}

test("accepts the exhaustive stored W00 baseline", () => {
  const report = verifyParityData(cleanData());
  assert.equal(report.ok, true);
  assert.deepEqual(report.counts, {
    capabilities: 84,
    constraints: 7,
    inventoryRecords: 6531,
    mappings: 6531,
    fixtures: 9,
    hardwareProfiles: 2,
    dependencyAssets: 12,
    lockControlledConsumers: 0,
  });
  assert.equal(report.untracked.length, 0);
  assert.equal(report.duplicates.length, 0);
  assert.equal(report.unresolved.length, 0);
  assert.equal(report.lockViolations.length, 0);
});

test("locks npm and CI to the required pre-build parity gate", () => {
  const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, "crates", "forge3d-web", "package.json"), "utf8"));
  const workflow = readFileSync(resolve(repositoryRoot, ".github", "workflows", "web.yml"), "utf8");
  assert.equal(packageJson.scripts["verify:parity"], "node --test tests/parity/verify-parity-manifest.test.mjs && node ../../scripts/verify-parity-manifest.mjs");
  const parityGate = workflow.indexOf("- name: Verify composite parity manifest");
  const firstBuildOrTest = workflow.indexOf("- name: Check core no-default wasm build");
  assert(parityGate >= 0);
  assert(firstBuildOrTest > parityGate);
  assert.match(workflow.slice(parityGate, firstBuildOrTest), /npm run verify:parity/u);
});

test("rejects a duplicate artifact mapping", () => {
  const data = cleanData();
  data.manifest.mappings.push(structuredClone(data.manifest.mappings[0]));
  expectFailure(data, "duplicates", /duplicate mapping artifact/u);
});

test("rejects an inventory artifact without a mapping", () => {
  const data = cleanData();
  const artifactId = data.inventory.records[0].id;
  data.manifest.mappings = data.manifest.mappings.filter((mapping) => mapping.artifactId !== artifactId);
  expectFailure(data, "untracked", new RegExp(artifactId, "u"));
});

test("rejects a mapping to an unresolved capability", () => {
  const data = cleanData();
  data.manifest.mappings[0].capabilityId = "Z99";
  expectFailure(data, "unresolved", /non-capability Z99/u);
});

test("rejects blank owner, evidence, and test fields", () => {
  const data = cleanData();
  data.manifest.webTargets[0].owner = "";
  data.manifest.webTargets[0].evidence = [];
  data.manifest.webTargets[0].tests = [];
  expectFailure(data, "schemaErrors", /webTargets/u);
});

test("rejects a lock-controlled consumer without its dependency entry", () => {
  const data = cleanData();
  data.dependencyLock.assets.find((asset) => asset.id === "geotiff").id = "unlocked-geotiff";
  data.consumerRecords = [{ assetId: "geotiff", path: "crates/forge3d-web/src-ts/cog.ts", token: "geotiff", declaredVersion: "3.0.5" }];
  expectFailure(data, "lockViolations", /without geotiff lock entry/u);
});

test("rejects a non-exact lock-controlled consumer version", () => {
  const data = cleanData();
  data.consumerRecords = [{ assetId: "geotiff", path: "crates/forge3d-web/package.json", token: "geotiff", declaredVersion: "^3.0.5" }];
  expectFailure(data, "lockViolations", /expected exact 3\.0\.5/u);
});

test("rejects a missing fixture tolerance and profile budget", () => {
  const data = cleanData();
  data.fixtureContracts.fixtures[0].tolerances = {};
  data.fixtureContracts.fixtures[0].budgets.pop();
  expectFailure(data, "schemaErrors", /fixture contracts/u);
});

test("rejects a fixture generator digest that does not match its contract", () => {
  const data = cleanData();
  data.fixtureContracts.fixtures[0].generator.parameters.width += 1;
  expectFailure(data, "unresolved", /generator digest/u);
});

test("rejects incomplete reference hardware contracts", () => {
  const data = cleanData();
  const discrete = data.hardwareProfiles.profiles.find((profile) => profile.id === "reference-discrete");
  const integrated = data.hardwareProfiles.profiles.find((profile) => profile.id === "reference-integrated");
  discrete.adapterBudgetBytes = 8 * 1024 ** 3 - 1;
  discrete.requiredFeatures = discrete.requiredFeatures.filter((feature) => feature !== "timestamp-query");
  integrated.effectiveBudgetBytes = 4 * 1024 ** 3 - 1;
  expectFailure(data, "schemaErrors", /hardware profiles/u);
});

test("rejects a discrete profile without timestamp-query", () => {
  const data = cleanData();
  const discrete = data.hardwareProfiles.profiles.find((profile) => profile.id === "reference-discrete");
  discrete.requiredFeatures = discrete.requiredFeatures.filter((feature) => feature !== "timestamp-query");
  expectFailure(data, "unresolved", /must require timestamp-query/u);
});

test("rejects stale stored evidence digests", () => {
  const data = cleanData();
  data.digestErrors.push("composite inventory digest mismatch");
  expectFailure(data, "unresolved", /digest mismatch/u);
});

test("rejects experimental dependency entries without risk reviews", () => {
  const data = cleanData();
  const proj = data.dependencyLock.assets.find((asset) => asset.id === "proj-wasm");
  proj.review.security = "reviewed";
  proj.review.maintenance = "reviewed";
  expectFailure(data, "lockViolations", /proj-wasm/u);
});

test("rejects EXR when the WASM rayon exclusion drifts", () => {
  const data = cleanData();
  const exr = data.dependencyLock.assets.find((asset) => asset.id === "exr");
  exr.build.flags = exr.build.flags.filter((flag) => flag !== "default-rayon-disabled");
  expectFailure(data, "lockViolations", /default rayon/u);
});
