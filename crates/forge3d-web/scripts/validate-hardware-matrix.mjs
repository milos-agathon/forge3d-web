import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256Hex } from "./canonical-json.mjs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const matrixPath = join(
  packageRoot,
  "tests",
  "infrastructure",
  "hardware-matrix.json",
);

const requiredHostLabels = new Map([
  ["FW-MAC-M2-01", "hw-mac-m2"],
  ["FW-WIN-I12-01", "hw-win-intel12"],
  ["FW-LNX-I12-01", "hw-linux-intel12"],
  ["FW-LNX-NV-01", "hw-linux-rtx3070"],
]);
const requiredAttachedAssets = new Map([
  ["FW-TRACKPAD-01", null],
  ["FW-AND-QCOM-01", "android-qualcomm-s23"],
  ["FW-AND-MALI-01", "android-mali-pixel8"],
  ["FW-AND-PEN-01", "android-pen-tabs9"],
  ["FW-IOS-OLD-01", "ios-iphone11"],
  ["FW-IOS-NEW-01", "ios-iphone17pro"],
  ["FW-IPAD-01", "ipados-air11-m2"],
]);

export function validateHardwareMatrix(matrix, { requireProvisioned = false } = {}) {
  if (matrix.schemaVersion !== 1 || matrix.matrixId !== "forge3d-browser-lab-v1") {
    throw new Error("hardware matrix identity or schema version is invalid");
  }
  if (!Array.isArray(matrix.hosts) || matrix.hosts.length !== 4) {
    throw new Error("hardware matrix must contain exactly four hosts");
  }
  if (!Array.isArray(matrix.assets) || matrix.assets.length !== 7) {
    throw new Error("hardware matrix must contain exactly seven attached assets");
  }

  const allIds = [...matrix.hosts, ...matrix.assets].map((entry) => entry.assetId);
  if (new Set(allIds).size !== allIds.length) {
    throw new Error("hardware matrix asset IDs must be unique");
  }
  const expectedIds = new Set([
    ...requiredHostLabels.keys(),
    ...requiredAttachedAssets.keys(),
  ]);
  if (
    allIds.some((id) => !expectedIds.has(id)) ||
    [...expectedIds].some((id) => !allIds.includes(id))
  ) {
    throw new Error("hardware matrix contains a missing or unknown asset ID");
  }

  const controllerIdentities = new Set();
  for (const host of matrix.hosts) {
    const hardwareLabel = requiredHostLabels.get(host.assetId);
    if (
      host.requiredLabels.length !== 2 ||
      host.requiredLabels[0] !== "forge3d-web" ||
      host.requiredLabels[1] !== hardwareLabel
    ) {
      throw new Error(`${host.assetId} must contain only its two checked static labels`);
    }
    if (host.requiredLabels.some((label) => label.startsWith("jit-"))) {
      throw new Error("per-job JIT labels cannot be persisted in the matrix");
    }
    if (
      host.controller.identity !== `controller:${host.assetId}` ||
      controllerIdentities.has(host.controller.identity)
    ) {
      throw new Error(`${host.assetId} controller identity is missing or duplicated`);
    }
    controllerIdentities.add(host.controller.identity);
    if (!Array.isArray(host.requiredBrowserLanes) || host.requiredBrowserLanes.length === 0) {
      throw new Error(`${host.assetId} must own at least one browser lane`);
    }
    if (requireProvisioned) {
      if (
        matrix.provisioningState !== "active" ||
        host.state !== "active" ||
        host.maintenanceReason !== null ||
        host.controller.state !== "online"
      ) {
        throw new Error(`${host.assetId} is not provisioned and online`);
      }
      validateControllerKey(host);
    }
  }

  const hostMap = new Map(matrix.hosts.map((host) => [host.assetId, host]));
  for (const asset of matrix.assets) {
    if (asset.hostAssetId !== "FW-MAC-M2-01" || !hostMap.has(asset.hostAssetId)) {
      throw new Error(`${asset.assetId} must attach to FW-MAC-M2-01`);
    }
    if (!hostMap.get(asset.hostAssetId).attachedAssetIds.includes(asset.assetId)) {
      throw new Error(`${asset.assetId} is not reciprocally attached by its host`);
    }
    const expectedAppiumId = requiredAttachedAssets.get(asset.assetId);
    if (asset.appiumId !== expectedAppiumId) {
      throw new Error(`${asset.assetId} Appium ID does not match the frozen inventory`);
    }
    if (requireProvisioned && asset.state !== "active") {
      throw new Error(`${asset.assetId} is not active`);
    }
  }
  for (const host of matrix.hosts) {
    for (const assetId of host.attachedAssetIds) {
      const asset = matrix.assets.find((candidate) => candidate.assetId === assetId);
      if (!asset || asset.hostAssetId !== host.assetId) {
        throw new Error(`${host.assetId} references an invalid attached asset`);
      }
    }
  }

  const serialized = JSON.stringify(matrix);
  if (/"(?:serial|udid|bluetoothAddress|encodedJitConfig)"\s*:/iu.test(serialized)) {
    throw new Error("hardware matrix contains a forbidden stable identifier or credential");
  }
  return {
    ok: true,
    assetCount: allIds.length,
    hostCount: matrix.hosts.length,
    labInfrastructureDigest: sha256Hex(matrix),
    provisioned: requireProvisioned,
  };
}

function validateControllerKey(host) {
  const key = host.controller.publicJwk;
  if (
    !/^controller-[a-z0-9-]+-p256-v\d+$/u.test(host.controller.signingKeyId ?? "") ||
    key?.kty !== "EC" ||
    key?.crv !== "P-256" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(key.x ?? "") ||
    !/^[A-Za-z0-9_-]{43}$/u.test(key.y ?? "") ||
    key.d !== undefined
  ) {
    throw new Error(`${host.assetId} controller P-256 public key is invalid`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const requireProvisioned = process.argv.includes("--require-provisioned");
  const matrix = JSON.parse(readFileSync(matrixPath, "utf8"));
  console.log(JSON.stringify(validateHardwareMatrix(matrix, { requireProvisioned }), null, 2));
}
