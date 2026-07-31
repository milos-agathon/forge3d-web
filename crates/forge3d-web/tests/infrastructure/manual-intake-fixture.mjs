import { readFileSync } from "node:fs";

const checkedHardwareMatrix = JSON.parse(
  readFileSync(new URL("./hardware-matrix.json", import.meta.url), "utf8"),
);
const checkedDeviceMatrix = JSON.parse(
  readFileSync(new URL("../device/device-matrix.json", import.meta.url), "utf8"),
);

export function activeManualMatrices(assetId) {
  const hardwareMatrix = structuredClone(checkedHardwareMatrix);
  const deviceMatrix = structuredClone(checkedDeviceMatrix);
  const asset = hardwareMatrix.assets.find((value) => value.assetId === assetId);
  if (!asset) throw new Error(`unknown manual fixture asset: ${assetId}`);
  const host = hardwareMatrix.hosts.find(
    (value) => value.assetId === asset.hostAssetId,
  );
  if (!host) throw new Error(`missing manual fixture host: ${asset.hostAssetId}`);
  asset.state = "active";
  host.state = "active";
  host.maintenanceReason = null;
  host.controller.state = "online";
  return { hardwareMatrix, deviceMatrix };
}
