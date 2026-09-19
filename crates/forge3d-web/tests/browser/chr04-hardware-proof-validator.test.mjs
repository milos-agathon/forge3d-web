import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { validateChr04EdgeEvidence, validateChr04HardwareProofContract } from "../../scripts/chr04-hardware-proof-validator.mjs";
import { assertJsonSchema } from "../../scripts/json-schema-validator.mjs";
import { validChr04HardwareProof } from "./chr04-hardware-proof-fixture.mjs";

const schema = JSON.parse(readFileSync(new URL("./chr04-hardware-proof.schema.json", import.meta.url), "utf8"));
const policy = JSON.parse(readFileSync(new URL("../infrastructure/browser-policy.json", import.meta.url), "utf8"));

const expectedBinding = { lane: "edge-linux-rtx3070", assetId: "FW-LNX-NV-01", platform: "linux", commit: "a".repeat(40), packageSha256: "b".repeat(64) };
const context = {
  expectedBinding,
  browser: { name: "msedge", channel: "stable", version: "150.0.1.2" },
  driver: { name: "playwright-edge", version: "1.56.1" },
  system: { platform: "linux", osBuild: "Ubuntu 24.04.1", displayServer: "GNOME Wayland" },
  effectiveLaunchArguments: [],
  adapter: { isFallbackAdapter: false, secureContext: true, deviceCreated: true, surfacePresented: true,
    presentedFrameLumaSamples: [0.1, 0.8], presentedFrameLumaDelta: 0.7, lumaChanged: true },
};

test("validates exact CHR-04 Edge proof and outer provenance", () => {
  const proof = validChr04HardwareProof();
  assert.equal(validateChr04HardwareProofContract(proof, expectedBinding), proof);
  assert.equal(validateChr04EdgeEvidence({ proof, ...context }), proof);
});

test("rejects borrowed Chrome proof and mutated Edge bindings/provenance", () => {
  const proof = validChr04HardwareProof();
  for (const changed of [
    { proof: { ...proof, kind: "forge3d-chr03-chrome-hardware-proof-v1" } },
    { proof: { ...proof, binding: { ...proof.binding, assetId: "FW-MAC-M2-01" } } },
    { proof, browser: { ...context.browser, name: "chrome" } },
    { proof, browser: { ...context.browser, channel: "beta" } },
    { proof, browser: { ...context.browser, version: "unknown" } },
    { proof, browser: { ...context.browser, version: "unknown1" } },
    { proof, browser: { ...context.browser, version: "Edge latest 1" } },
    { proof, browser: { ...context.browser, version: "150.0.1" } },
    { proof, browser: { ...context.browser, version: "150.0.1.2.3" } },
    { proof, browser: { ...context.browser, version: "0.0.1.2" } },
    { proof, browser: { ...context.browser, version: undefined } },
    { proof, driver: { ...context.driver, name: "playwright-chrome" } },
    { proof, driver: { ...context.driver, version: "1.56" } },
    { proof, driver: { ...context.driver, version: "1.56.1.2" } },
    { proof, driver: { ...context.driver, version: "0.56.1" } },
    { proof, driver: { ...context.driver, version: "latest" } },
    { proof, driver: { ...context.driver, version: undefined } },
    { proof, system: { ...context.system, displayServer: "X11" } },
    { proof, effectiveLaunchArguments: ["--enable-unsafe-webgpu"] },
    { proof, adapter: { ...context.adapter, isFallbackAdapter: true } },
  ]) assert.throws(() => validateChr04EdgeEvidence({ ...context, ...changed }));
});

test("rejects every policy argument with and without a value", () => {
  for (const argument of policy.prohibitedLaunchArguments) {
    for (const effective of [argument, `${argument}=value`]) {
      assert.throws(() => validateChr04EdgeEvidence({
        proof: validChr04HardwareProof(), ...context, effectiveLaunchArguments: [effective],
      }), /prohibited browser launch arguments/u);
    }
  }
});

test("schema closes nested payloads and Edge observations", () => {
  const mutations = [
    (proof) => { proof.driver.extra = true; },
    (proof) => { proof.driver.keyboard.orbit.extra = true; },
    (proof) => { proof.lifecycleCycles[0].cycle = 51; },
    (proof) => { proof.benchmark.scheduling.maxOutstandingFrames = 2; },
    (proof) => { proof.edgeAcceptance.extra = true; },
    (proof) => { proof.edgeAcceptance.touch.extra = true; },
    (proof) => { proof.edgeAcceptance.unsupported.nullAdapter.extra = true; },
    (proof) => { delete proof.edgeAcceptance.unsupported.missingApi.publicCode; },
  ];
  for (const mutate of mutations) {
    const proof = validChr04HardwareProof();
    mutate(proof);
    assert.throws(() => assertJsonSchema(proof, schema), /JSON schema validation failed/u);
  }
});

test("rejects missing or mutated touch and unsupported diagnostics", () => {
  const mutations = [
    (proof) => { delete proof.edgeAcceptance; },
    (proof) => { proof.edgeAcceptance.touch.viewChanged = false; },
    (proof) => { proof.edgeAcceptance.unsupported.nullAdapter.publicCode = "WEBGPU_UNAVAILABLE"; },
    (proof) => { proof.edgeAcceptance.unsupported.nullAdapter.unsupportedVisible = false; },
    (proof) => { proof.edgeAcceptance.unsupported.nullAdapter.hasBypassAdvice = true; },
    (proof) => { proof.edgeAcceptance.unsupported.nullAdapter.bypassLinks = 1; },
  ];
  for (const mutate of mutations) {
    const proof = validChr04HardwareProof();
    mutate(proof);
    assert.throws(() => validateChr04EdgeEvidence({ proof, ...context }));
  }
});

test("reuses full FND-07 payload validation", () => {
  const proof = validChr04HardwareProof();
  proof.lifecycleCycles.pop();
  assert.throws(() => validateChr04EdgeEvidence({ proof, ...context }), /50 items|50 lifecycle/u);
});
