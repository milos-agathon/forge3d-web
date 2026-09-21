import assert from "node:assert/strict";
import test from "node:test";

import { validateFfx03HardwareProof, validateFfx03ProbeOutcome } from "../../scripts/ffx03-hardware-proof-validator.mjs";
import { validFfx03NightlyOutcome, validFfx03Proof } from "./ffx03-proof-fixture.mjs";

test("accepts complete stable FFX-03 proof and closed Nightly outcomes", () => {
  assert.equal(validateFfx03HardwareProof(validFfx03Proof()).kind, "forge3d-ffx03-firefox-hardware-proof-v1");
  for (const outcome of ["PROBE_PASS", "UNAVAILABLE", "PRODUCT_FAILURE"])
    assert.equal(validateFfx03ProbeOutcome(validFfx03NightlyOutcome({ outcome })).outcome, outcome);
});

for (const [name, mutate] of [
  ["wrong architecture", (proof) => { proof.binding.architecture = "x64"; }],
  ["wrong workload schema", (proof) => { proof.workload.schemaVersion = 2; }],
  ["numeric behavior", (proof) => { proof.workload.behaviors.orbit = 1; }],
  ["numeric driver boolean", (proof) => { proof.workload.driver.orbitChanged = 1; }],
  ["zero pointer id", (proof) => { proof.workload.driver.pointerCapture.pointerId = 0;
    proof.workload.driver.pointerCapture.capturedPointerId = 0;
    proof.workload.driver.pointerCapture.releasedPointerId = 0; }],
  ["numeric keyboard boolean", (proof) => { proof.workload.driver.keyboard.orbit.changed = 1; }],
  ["numeric focus boolean", (proof) => { proof.workload.benchmark.documentHasFocusBefore = 1; }],
  ["unknown thermal state", (proof) => { proof.workload.benchmark.thermalStateBefore = "cool"; }],
  ["unknown low power state", (proof) => { proof.workload.benchmark.lowPowerModeAfter = "unknown"; }],
  ["fabricated Firefox SystemInfo", (proof) => { proof.workload.systemInfo.available = true;
    proof.workload.systemInfo.value = {}; proof.workload.systemInfo.unavailableReason = null; }],
  ["release preference override", (proof) => { proof.configuration.afterWorkload["dom.webgpu.enabled"] = true; }],
  ["49 cleanup cycles", (proof) => { proof.workload.lifecycleCycles.pop(); }],
  ["observer leak", (proof) => { proof.workload.lifecycleCycles[3].afterDispose.activeObservers = 1; }],
  ["trimmed benchmark", (proof) => { proof.workload.benchmark.rafTimestampsMs.pop(); }],
  ["altered hash", (proof) => { proof.workload.benchmark.terrainSha256 = "0".repeat(64); }],
  ["cleanup failure", (proof) => { proof.cleanup.browserAbsent = false; }],
  ["unknown nested field", (proof) => { proof.driver.untrusted = true; }],
  ["unknown adapter field", (proof) => { proof.adapter.untrusted = true; }],
  ["misbound adapter", (proof) => { proof.adapter.assetId = "FW-WIN-I12-01"; }],
  ["unknown behavior field", (proof) => { proof.workload.behaviors.untrusted = true; }],
  ["unknown lifecycle field", (proof) => { proof.workload.lifecycleCycles[0].untrusted = true; }],
]) test(`stable validator rejects ${name}`, () => {
  const proof = validFfx03Proof(); mutate(proof);
  assert.throws(() => validateFfx03HardwareProof(proof));
});

test("Nightly validator rejects unsafe preferences and fabricated unsuccessful adapter", () => {
  const unsafe = validFfx03NightlyOutcome();
  unsafe.configuration.afterWorkload["dom.webgpu.unsafe"] = true;
  assert.throws(() => validateFfx03ProbeOutcome(unsafe), /preference/u);
  const absent = validFfx03NightlyOutcome({ outcome: "UNAVAILABLE" });
  absent.adapter = { secureContext: true, isFallbackAdapter: false };
  assert.throws(() => validateFfx03ProbeOutcome(absent), /fabricate/u);
  const unsafeLaunch = validFfx03NightlyOutcome();
  unsafeLaunch.launch.arguments.push("--ignore-certificate-errors");
  assert.throws(() => validateFfx03ProbeOutcome(unsafeLaunch), /launch observation/u);
  const borrowedAdapter = validFfx03NightlyOutcome();
  borrowedAdapter.adapter.assetId = "FW-LNX-NV-01";
  assert.throws(() => validateFfx03ProbeOutcome(borrowedAdapter), /misbound/u);
});
