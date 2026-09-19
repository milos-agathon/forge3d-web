import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson } from "../../scripts/canonical-json.mjs";
import { mergeBrowserEvidence } from "../../scripts/merge-browser-evidence.mjs";
import { createSafariSupportPublication } from "../../scripts/safari-support-publication.mjs";
import {
  targetSha,
  validSafariPublicationInput,
} from "./safari-support-publication-fixture.mjs";

test("full 24-row input emits one deterministic narrow Safari support document", () => {
  const input = validSafariPublicationInput();
  const first = createSafariSupportPublication(input);
  const second = createSafariSupportPublication(input);
  assert.equal(first.document, second.document);
  assert.equal(first.sha256, second.sha256);
  assert.match(first.document, /Safari 26\.0 stable/u);
  assert.doesNotMatch(first.document, /minimum qualified/u);
  assert.match(first.document, /macOS 26\.0 build 25A456/u);
  assert.match(first.document, /Apple M2/u);
  assert.match(first.document, /package-forge3d-web-1\.26\.3\.tgz/u);
  assert.match(first.document, /manual-media-701-703-safari-proof\.mp4/u);
  assert.match(first.document, /Trackpad pinch is explicitly not/u);
  assert.match(first.document, /remain `NOT_PROVEN`/u);
  assert.equal(first.document.endsWith("\n"), false);
});

test("closed finalized set rejects missing, extra, duplicate, and raw noncanonical input", () => {
  const missing = validSafariPublicationInput();
  missing.records.pop();
  missing.recordBytes.pop();
  assert.throws(() => createSafariSupportPublication(missing), /24-row/u);

  const extra = validSafariPublicationInput();
  extra.records.push(structuredClone(extra.records[0]));
  extra.recordBytes.push(extra.recordBytes[0]);
  assert.throws(() => createSafariSupportPublication(extra), /24-row/u);

  const duplicate = validSafariPublicationInput();
  duplicate.records[1] = structuredClone(duplicate.records[0]);
  duplicate.recordBytes[1] = bytes(duplicate.records[1]);
  assert.throws(() => createSafariSupportPublication(duplicate), /24-row/u);

  for (const field of ["readinessBytes", "labReadinessBytes", "packageRunBytes"]) {
    const changed = validSafariPublicationInput();
    changed[field] = Buffer.from(` ${changed[field].toString("utf8")}`);
    assert.throws(() => createSafariSupportPublication(changed), /canonical JSON/u);
  }
  const rawRecord = validSafariPublicationInput();
  rawRecord.recordBytes[0] = Buffer.from(JSON.stringify(rawRecord.records[0]));
  assert.throws(() => createSafariSupportPublication(rawRecord), /canonical JSON/u);
});

test("SHA, package, run, attempt, artifact, digest, and lab drift fail closed", () => {
  const mutations = [
    (value) => { value.targetSha = "f".repeat(40); },
    (value) => { value.readiness.packageSha256 = "0".repeat(64); value.readinessBytes = bytes(value.readiness); },
    (value) => { value.packageRun.packageRunId += 1; value.packageRunBytes = bytes(value.packageRun); },
    (value) => { value.records[0].workflow.runAttempt += 1; value.recordBytes[0] = bytes(value.records[0]); },
    (value) => { value.readinessRun.id += 1; },
    (value) => { value.readinessRun.run_attempt = 0; },
    (value) => { value.readiness.recordDigests[0].artifactId += 1; value.readinessBytes = bytes(value.readiness); },
    (value) => { value.readiness.recordDigests[0].sha256 = "0".repeat(64); value.readinessBytes = bytes(value.readiness); },
    (value) => { value.labReadiness.labInfrastructureDigest = "0".repeat(64); value.labReadinessBytes = bytes(value.labReadiness); },
  ];
  for (const mutate of mutations) {
    const changed = validSafariPublicationInput();
    mutate(changed);
    assert.throws(() => createSafariSupportPublication(changed));
  }
});

test("replay disagreement, future readiness, current expiry, and equality boundary fail", () => {
  const disagreement = validSafariPublicationInput();
  disagreement.readiness.evidenceRunIds.reverse();
  disagreement.readinessBytes = bytes(disagreement.readiness);
  assert.throws(() => createSafariSupportPublication(disagreement), /replay/u);

  const future = validSafariPublicationInput();
  future.now = new Date("2026-09-17T23:59:59.999Z");
  assert.throws(() => createSafariSupportPublication(future), /future/u);

  for (const instant of ["2026-10-05T00:00:00.000Z", "2026-10-05T00:00:00.001Z"]) {
    const expired = validSafariPublicationInput();
    expired.now = new Date(instant);
    assert.throws(() => createSafariSupportPublication(expired), /fresh/u);
  }
  const before = validSafariPublicationInput();
  before.now = new Date("2026-10-04T23:59:59.999Z");
  assert.doesNotThrow(() => createSafariSupportPublication(before));
});

test("every manual row must remain fresh at publication, including the equality boundary", () => {
  const key = "manual:FW-IOS-OLD-01:mobile-multitouch";
  const expired = validSafariPublicationInput();
  expired.records.find((record) => record.key === key).expiresAt =
    "2026-09-19T00:00:00.000Z";
  rebind(expired);
  assert.throws(
    () => createSafariSupportPublication(expired),
    new RegExp(`currently fresh: ${key}`),
  );

  const before = validSafariPublicationInput();
  before.records.find((record) => record.key === key).expiresAt =
    "2026-09-19T00:00:00.000Z";
  before.now = new Date("2026-09-18T23:59:59.999Z");
  rebind(before);
  assert.doesNotThrow(() => createSafariSupportPublication(before));
});

test("production lowercase Safari and independently captured stable host identity pass", () => {
  const input = validSafariPublicationInput();
  const { manual } = safariPair(input);
  manual.hostInventory.capturedAt = "2026-09-18T00:01:00.000Z";
  manual.hostInventory.session.identifier = "manual-console";
  manual.hostInventory.trackpad.capturedAt = "2026-09-18T00:00:30.000Z";
  manual.hostInventory.trackpad.batteryState = "81%";
  manual.hostInventory.attachedAssetIds.reverse();
  manual.hostInventory.attachedAssets.reverse();
  manual.session.hostInventory = structuredClone(manual.hostInventory);
  rebind(input);
  assert.equal(manual.browser.name, "safari");
  assert.doesNotThrow(() => createSafariSupportPublication(input));
});

test("each Safari record is bound to its own safe stable browser and driver inventory", () => {
  const mutations = [
    (inventory) => { inventory.effectiveLaunchArguments = ["--ignore-certificate-errors"]; },
    (inventory) => { inventory.effectiveLaunchArguments = ["--synthetic-safe-but-nonempty"]; },
    (inventory) => { inventory.tools.safaridriverPath = "/tmp/fake-safaridriver"; },
    (inventory) => { inventory.tools.safaridriverVersion = "Safari Technology Preview"; },
    (inventory) => { safariInventoryBrowser(inventory).id = "safari-technology-preview"; },
    (inventory) => { safariInventoryBrowser(inventory).channel = "technology-preview"; },
    (inventory) => { safariInventoryBrowser(inventory).version = "26.1"; },
    (inventory) => {
      safariInventoryBrowser(inventory).executable =
        "/Applications/Safari Technology Preview.app/Contents/MacOS/Safari Technology Preview";
    },
  ];
  for (const side of ["automated", "manual"]) {
    for (const mutate of mutations) {
      const input = validSafariPublicationInput();
      const pair = safariPair(input);
      mutate(pair[side].hostInventory);
      if (side === "manual") {
        pair.manual.session.hostInventory = structuredClone(pair.manual.hostInventory);
      }
      rebind(input);
      assert.throws(() => createSafariSupportPublication(input));
    }
  }
});

test("attested manifest, exact release name, and selected tarball bytes are bound", () => {
  const wrongBytes = validSafariPublicationInput();
  wrongBytes.packageAssetBytes = Buffer.from("substituted package\n", "utf8");
  assert.throws(() => createSafariSupportPublication(wrongBytes), /tarball bytes/u);

  const wrongName = validSafariPublicationInput();
  wrongName.packageAssetName = "package-substituted.tgz";
  assert.throws(() => createSafariSupportPublication(wrongName), /tarball name/u);

  const wrongManifest = validSafariPublicationInput();
  wrongManifest.packageManifest.packageSha256 = "0".repeat(64);
  wrongManifest.packageManifestBytes = Buffer.from(
    `${JSON.stringify(wrongManifest.packageManifest, null, 2)}\n`,
    "utf8",
  );
  assert.throws(() => createSafariSupportPublication(wrongManifest), /manifest/u);
});

test("evidence-derived Markdown rejects controls and escapes structural punctuation", () => {
  const newline = validSafariPublicationInput();
  setDriverVersion(safariPair(newline), "26.0\nforged heading");
  rebind(newline);
  assert.throws(() => createSafariSupportPublication(newline), /control text/u);

  for (const [value, escaped] of [
    ["26|0", "26\\|0"],
    ["`26`", "\\`26\\`"],
    ["[proof](https://evil.test)", "\\[proof\\]\\(https://evil.test\\)"],
  ]) {
    const input = validSafariPublicationInput();
    setDriverVersion(safariPair(input), value);
    rebind(input);
    assert.match(createSafariSupportPublication(input).document, new RegExp(escapeRegExp(escaped), "u"));
  }
});

test("Safari brand/version/platform/hardware/driver/launch substitutions fail", () => {
  const cases = [
    (pair) => setBrowser(pair, { name: "WebKit", channel: "stable", version: "26.0" }),
    (pair) => setBrowser(pair, { name: "Safari", channel: "technology-preview", version: "26.0" }),
    (pair) => setBrowser(pair, { name: "Safari", channel: "stable", version: "25.9" }),
    (pair) => setBrowser(pair, { name: "Safari", channel: "stable", version: "latest" }),
    (pair) => { pair.automated.system.osBuild = "macOS 15.7 build 24G1"; pair.manual.system.build = pair.automated.system.osBuild; pair.automated.hostInventory.osBuild = pair.automated.system.osBuild; pair.manual.hostInventory.osBuild = pair.automated.system.osBuild; },
    (pair) => { pair.automated.system.platform = "linux"; pair.automated.hostInventory.platform = "linux"; pair.manual.system.os = "linux"; pair.manual.hostInventory.platform = "linux"; pair.manual.session.system.os = "linux"; pair.manual.session.hostInventory.platform = "linux"; },
    (pair) => { pair.automated.hostInventory.cpu = "Intel Core i7"; pair.manual.hostInventory.cpu = "Intel Core i7"; },
    (pair) => { pair.automated.driver.name = "playwright-webkit"; pair.manual.driver.name = "playwright-webkit"; pair.manual.session.driver.name = "playwright-webkit"; },
    (pair) => { pair.automated.hostInventory.tools.safaridriverPath = "/tmp/safaridriver"; pair.manual.hostInventory.tools.safaridriverPath = "/tmp/safaridriver"; pair.manual.session.hostInventory.tools.safaridriverPath = "/tmp/safaridriver"; },
    (pair) => { pair.automated.effectiveLaunchArguments = ["--ignore-certificate-errors"]; },
  ];
  for (const mutate of cases) {
    const changed = validSafariPublicationInput();
    const pair = safariPair(changed);
    mutate(pair);
    assert.throws(() => {
      rebind(changed);
      createSafariSupportPublication(changed);
    });
  }
});

test("automation/manual mismatch, legacy/missing/extra checklist, and media substitution fail", () => {
  const mismatched = validSafariPublicationInput();
  const pair = safariPair(mismatched);
  pair.manual.driver.version = "26.1";
  pair.manual.session.driver.version = "26.1";
  assert.throws(() => {
    rebind(mismatched);
    createSafariSupportPublication(mismatched);
  });

  for (const changeSteps of [
    (steps) => { steps.TRACKPAD_PINCH_ZOOM = "pass"; },
    (steps) => { delete steps.TRACKPAD_ORBIT; },
    (steps) => { steps.UNLISTED_STEP = "pass"; },
  ]) {
    const changed = validSafariPublicationInput();
    changeSteps(safariPair(changed).manual.stepResults);
    changed.recordBytes = changed.records.map(bytes);
    assert.throws(() => createSafariSupportPublication(changed));
  }

  const media = validSafariPublicationInput();
  media.manualMediaPlan.intakes[0].evidenceArtifactId += 1;
  assert.throws(() => createSafariSupportPublication(media), /media/u);
});

function safariPair(input) {
  return {
    automated: input.records.find((record) => record.key === "automated:FW-MAC-M2-01:safari-macos-m2"),
    manual: input.records.find((record) => record.key === "manual:FW-TRACKPAD-01:safari-trackpad"),
  };
}

function setBrowser({ automated, manual }, browser) {
  automated.browser = structuredClone(browser);
  manual.browser = structuredClone(browser);
  manual.session.browser = structuredClone(browser);
}

function setDriverVersion({ automated, manual }, version) {
  automated.driver.version = version;
  manual.driver.version = version;
  manual.session.driver.version = version;
  automated.hostInventory.tools.safaridriverVersion = version;
  manual.hostInventory.tools.safaridriverVersion = version;
  manual.session.hostInventory.tools.safaridriverVersion = version;
}

function safariInventoryBrowser(inventory) {
  return inventory.browsers.find((browser) => browser.id === "safari-stable");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function rebind(input) {
  const replay = mergeBrowserEvidence({
    targetSha,
    packageSha256: input.readiness.packageSha256,
    labReadiness: {
      status: "LAB_INFRA_READY",
      run: { id: input.readiness.labReadiness.runId },
      runId: input.readiness.labReadiness.runId,
      packageRunId: input.readiness.packageRunId,
      candidateSha: targetSha,
      packageSha256: input.readiness.packageSha256,
      manifestSha256: input.readiness.labReadiness.manifestSha256,
      labInfrastructureDigest: input.readiness.labReadiness.labInfrastructureDigest,
    },
    records: input.records,
    matrix: input.matrix,
    now: new Date(input.readiness.createdAt),
  });
  input.readiness = replay.manifest;
  input.readinessBytes = bytes(input.readiness);
  input.recordBytes = input.records.map(bytes);
}

function bytes(value) {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}
