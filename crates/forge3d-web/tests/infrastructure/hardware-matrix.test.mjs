import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { validateHardwareMatrix } from "../../scripts/validate-hardware-matrix.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const matrix = JSON.parse(readFileSync(join(root, "hardware-matrix.json"), "utf8"));

test("validates all eleven public assets and exact static routing labels", () => {
  const result = validateHardwareMatrix(matrix);
  assert.equal(result.assetCount, 11);
  assert.equal(result.hostCount, 4);
  assert.match(result.labInfrastructureDigest, /^[0-9a-f]{64}$/u);
});

test("checked matrix cannot satisfy live readiness while controllers are unprovisioned", () => {
  assert.throws(
    () => validateHardwareMatrix(matrix, { requireProvisioned: true }),
    /not provisioned and online/u,
  );
});

for (const [name, mutate, expected] of [
  [
    "host label",
    (copy) => copy.hosts[0].requiredLabels.pop(),
    /two checked static labels/u,
  ],
  [
    "JIT label",
    (copy) => {
      copy.hosts[0].requiredLabels[1] = "jit-persisted";
    },
    /two checked static labels|JIT labels/u,
  ],
  [
    "device",
    (copy) => copy.assets.pop(),
    /exactly seven/u,
  ],
  [
    "duplicate asset",
    (copy) => {
      copy.assets[1].assetId = copy.assets[0].assetId;
    },
    /unique/u,
  ],
  [
    "unknown attachment",
    (copy) => {
      copy.hosts[0].attachedAssetIds[0] = "FW-UNKNOWN-01";
    },
    /not reciprocally attached|invalid attached/u,
  ],
  [
    "Appium ID",
    (copy) => {
      copy.assets[1].appiumId = "caller-selected";
    },
    /Appium ID/u,
  ],
]) {
  test(`rejects a changed ${name}`, () => {
    const copy = structuredClone(matrix);
    mutate(copy);
    assert.throws(() => validateHardwareMatrix(copy), expected);
  });
}
