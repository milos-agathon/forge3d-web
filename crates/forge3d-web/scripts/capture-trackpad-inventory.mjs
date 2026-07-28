import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const assetId = "FW-TRACKPAD-01";
const expectedModel = "Apple Magic Trackpad USB-C (2024), A3120";

export function captureTrackpadInventory({
  usbProfile,
  bluetoothProfile,
  capturedAt = new Date(),
}) {
  const usbMatch = findTrackpad(usbProfile);
  const bluetoothMatch = findTrackpad(bluetoothProfile);
  if (!usbMatch || !bluetoothMatch) {
    throw new Error(
      "Magic Trackpad must be present in both USB and Bluetooth system profiles",
    );
  }
  const modelIdentifier = firstAllowlisted(
    bluetoothMatch.value,
    usbMatch.value,
    ["device_model", "model_id", "Model Identifier", "model"],
  );
  if (String(modelIdentifier ?? "").toUpperCase() !== "A3120") {
    throw new Error("Magic Trackpad is not the fixed USB-C model A3120");
  }
  const direct = !usbMatch.ancestors.some((name) => /\bhub\b/iu.test(name));
  if (!direct) {
    throw new Error("Magic Trackpad USB capture must use a direct cable without a hub");
  }
  const firmware = firstAllowlisted(
    bluetoothMatch.value,
    usbMatch.value,
    ["device_firmwareVersion", "firmware_version", "Firmware Version"],
  );
  const batteryState = normalizeBattery(
    firstAllowlisted(
      bluetoothMatch.value,
      usbMatch.value,
      ["device_batteryLevel", "battery_level", "Battery Level"],
    ),
  );
  if (!firmware) {
    throw new Error("Magic Trackpad firmware was not present in the allowlisted fields");
  }
  return {
    assetId,
    model: expectedModel,
    firmware: String(firmware),
    transport: "Bluetooth",
    batteryState,
    capturedAt: new Date(capturedAt).toISOString(),
    topology: {
      pairingAndCharging: "direct-usb-c-to-usb-c",
      gestures: "bluetooth",
      hubPresent: false,
    },
  };
}

function findTrackpad(profile) {
  const matches = [];
  visit(profile, [], matches);
  return matches.find(({ value }) =>
    /magic trackpad/iu.test(
      String(
        value._name ??
          value.device_name ??
          value.product_name ??
          value["Product Name"] ??
          "",
      ),
    ),
  );
}

function visit(value, ancestors, matches) {
  if (Array.isArray(value)) {
    for (const item of value) {
      visit(item, ancestors, matches);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  const name = String(
    value._name ??
      value.device_name ??
      value.product_name ??
      value["Product Name"] ??
      "",
  );
  matches.push({ value, ancestors });
  const nextAncestors = name ? [...ancestors, name] : ancestors;
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") {
      visit(child, nextAncestors, matches);
    }
  }
}

function firstAllowlisted(...args) {
  const keys = args.pop();
  for (const value of args) {
    for (const key of keys) {
      if (value && Object.hasOwn(value, key) && value[key] !== "") {
        return value[key];
      }
    }
  }
  return null;
}

function normalizeBattery(value) {
  const match = String(value ?? "").match(/(\d{1,3})\s*%?/u);
  if (!match) {
    return "unknown";
  }
  const percent = Math.min(100, Number(match[1]));
  return `${percent}%`;
}

function parseArguments(argv) {
  const result = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || result.has(key)) {
      throw new Error(`invalid or duplicate argument near ${key ?? "<end>"}`);
    }
    result.set(key, value);
  }
  return result;
}

function loadProfile(path, dataType) {
  if (path) {
    return JSON.parse(readFileSync(path, "utf8"));
  }
  if (process.platform !== "darwin") {
    throw new Error(`${dataType} capture without a fixture requires macOS`);
  }
  const result = spawnSync("system_profiler", [dataType, "-json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`system_profiler ${dataType} failed: ${result.stderr.trim()}`);
  }
  return JSON.parse(result.stdout);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArguments(process.argv.slice(2));
  const outputPath = args.get("--output");
  if (!outputPath) {
    throw new Error("--output is required");
  }
  const inventory = captureTrackpadInventory({
    usbProfile: loadProfile(args.get("--usb-json"), "SPUSBDataType"),
    bluetoothProfile: loadProfile(
      args.get("--bluetooth-json"),
      "SPBluetoothDataType",
    ),
  });
  const output = `${JSON.stringify(inventory, null, 2)}\n`;
  writeFileSync(outputPath, output, { encoding: "utf8", mode: 0o600 });
  console.log(
    JSON.stringify({
      ok: true,
      assetId: inventory.assetId,
      output: outputPath,
    }),
  );
}
