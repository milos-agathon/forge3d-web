import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  captureHostInventory,
  validateHostInventory,
} from "../../scripts/capture-host-inventory.mjs";
import { captureTrackpadInventory } from "../../scripts/capture-trackpad-inventory.mjs";
import { resolveHostRuntime } from "../../scripts/resolve-host-runtime.mjs";
import {
  assertCompleteHostInventory,
  readHostCanaryInput,
} from "../../../../tools/browser-lab-controller/src/controller-evidence-inputs.mjs";
import { assertJsonSchema } from "../browser/json-schema-validator.mjs";

const matrix = readJson("hardware-matrix.json");
const inventoryHelper = join(
  import.meta.dirname,
  "../../scripts/capture-host-inventory.mjs",
);
const inventoryHelperSha256 = createHash("sha256")
  .update(readFileSync(inventoryHelper))
  .digest("hex");
const policy = readJson("browser-policy.json");
const schema = readJson("host-inventory.schema.json");
const hostId = "FW-MAC-M2-01";
const host = matrix.hosts.find((candidate) => candidate.assetId === hostId);
const browser = {
  id: "chrome-stable",
  channel: "stable",
  classification: "required",
  automation: "playwright",
  version: "150.0.7339.1",
  executable: "/Applications/Google Chrome.app",
};
const tools = {
  ...policy.tools,
  safaridriverVersion: "Included with Safari 26.0",
};
const trackpad = captureTrackpadInventory({
  usbProfile: {
    SPUSBDataType: [
      {
        _name: "USB 3.1 Bus",
        _items: [
          {
            _name: "Magic Trackpad",
            model_id: "A3120",
            firmware_version: "3.1.2",
            serial_num: "DISCARDED-SERIAL",
          },
        ],
      },
    ],
  },
  bluetoothProfile: {
    SPBluetoothDataType: [
      {
        _name: "Magic Trackpad",
        device_model: "A3120",
        device_firmwareVersion: "3.1.2",
        device_batteryLevel: "87%",
        device_address: "AA-BB-CC-DD-EE-FF",
      },
    ],
  },
  capturedAt: new Date("2026-07-29T07:59:00.000Z"),
});

test("Mac canary producer emits the exact seven-asset schema-valid signed inventory", () => {
  const observedHardware = hardwareObservation();
  const calls = [];
  const result = resolveHostRuntime({
    helper: inventoryHelper,
    helperSha256: inventoryHelperSha256,
    lane: "infrastructure-canary",
    hostId,
    policy,
    matrix,
    trackpadInventory: trackpad,
    platform: "darwin",
    environment: {},
    now: new Date("2026-07-29T08:00:00.000Z"),
    execute: (command) => {
      calls.push(command);
      if (command === inventoryHelper) {
        return JSON.stringify({
          schemaVersion: 1,
          hostId,
          lane: "infrastructure-canary",
          platform: "darwin",
          displayServer: "WindowServer",
          browsers: [browser],
          tools,
          launchArguments: [],
          hardware: observedHardware,
        });
      }
      if (command === "/usr/bin/sw_vers") return "25A123\n";
      if (command === "/usr/bin/stat") return "forge3d\n";
      if (command === "/usr/sbin/ioreg") {
        return '    "CGSSessionScreenIsLocked" = No\n';
      }
      throw new Error(`unexpected command ${command}`);
    },
  });
  assertJsonSchema(result.inventory, schema);
  assert.deepEqual(result.inventory.attachedAssetIds, host.attachedAssetIds);
  assert.equal(result.inventory.attachedAssets.length, 7);
  assert.equal(result.inventory.trackpad.firmware, "3.1.2");
  assert.doesNotThrow(() =>
    assertCompleteHostInventory(result.inventory, {
      authorization: { hostId, lane: "infrastructure-canary" },
    }),
  );
  assert.deepEqual(calls, [
    inventoryHelper,
    "/usr/bin/sw_vers",
    "/usr/bin/stat",
    "/usr/sbin/ioreg",
  ]);
  assert.equal(JSON.stringify(result.inventory).includes("DISCARDED-SERIAL"), false);
  assert.equal(JSON.stringify(result.inventory).includes("AA-BB-CC-DD-EE-FF"), false);
});

test("SAF-03 captures the same exact Mac and trackpad inventory contract", () => {
  const result = resolveHostRuntime({
    helper: inventoryHelper,
    helperSha256: inventoryHelperSha256,
    lane: "safari-macos-m2",
    hostId,
    policy,
    matrix,
    trackpadInventory: trackpad,
    platform: "darwin",
    environment: {},
    now: new Date("2026-07-29T08:00:00.000Z"),
    execute: (command) => {
      if (command === inventoryHelper) {
        return JSON.stringify({
          schemaVersion: 1,
          hostId,
          lane: "safari-macos-m2",
          platform: "darwin",
          displayServer: "WindowServer",
          browsers: [browser],
          tools,
          launchArguments: [],
          hardware: hardwareObservation(),
        });
      }
      if (command === "/usr/bin/sw_vers") return "25A123\n";
      if (command === "/usr/bin/stat") return "forge3d\n";
      if (command === "/usr/sbin/ioreg") {
        return '    "CGSSessionScreenIsLocked" = No\n';
      }
      throw new Error(`unexpected command ${command}`);
    },
  });
  assertJsonSchema(result.inventory, schema);
  assert.equal(result.inventory.trackpad.assetId, "FW-TRACKPAD-01");
  assert.deepEqual(result.inventory.attachedAssetIds, host.attachedAssetIds);
});

test("exact capture rejects missing substituted and duplicate attachment observations", () => {
  const missing = hardwareObservation();
  missing.attachedAssets.pop();
  assert.throws(() => captureExact(missing), /exact set/u);

  const substitutedModel = hardwareObservation();
  substitutedModel.attachedAssets[1].model = "substituted handset";
  assert.throws(() => captureExact(substitutedModel), /checked matrix/u);

  const substitutedAlias = hardwareObservation();
  substitutedAlias.attachedAssets[1].appiumId = "other-device";
  assert.throws(() => captureExact(substitutedAlias), /checked matrix/u);

  const duplicate = hardwareObservation();
  duplicate.attachedAssets[1] = structuredClone(duplicate.attachedAssets[0]);
  assert.throws(() => captureExact(duplicate), /exact set/u);
});

test("controller input and hosted validation reject missing and unsafe trackpad evidence", () => {
  const inventory = captureExact(hardwareObservation());
  const missingAttachments = structuredClone(inventory);
  delete missingAttachments.attachedAssetIds;
  assert.throws(
    () =>
      assertCompleteHostInventory(missingAttachments, {
        authorization: { hostId, lane: "infrastructure-canary" },
      }),
    /incomplete/u,
  );

  const missingTrackpad = structuredClone(inventory);
  missingTrackpad.trackpad = null;
  assert.throws(
    () =>
      assertCompleteHostInventory(missingTrackpad, {
        authorization: { hostId, lane: "infrastructure-canary" },
      }),
    /trackpad inventory/u,
  );

  const changedTrackpad = structuredClone(inventory);
  changedTrackpad.trackpad.model = "Apple Magic Trackpad A1535";
  assert.throws(
    () =>
      validateHostInventory(changedTrackpad, {
        matrix,
        requireTrackpad: true,
      }),
    /direct topology/u,
  );

  const hubTrackpad = structuredClone(inventory);
  hubTrackpad.trackpad.topology.hubPresent = true;
  assert.throws(
    () =>
      validateHostInventory(hubTrackpad, { matrix, requireTrackpad: true }),
    /direct topology/u,
  );
});

test("controller evidence reader preserves the producer attachment set and rejects omissions", () => {
  const root = mkdtempSync(join(tmpdir(), "forge3d-host-inventory-"));
  const authorization = { hostId, lane: "infrastructure-canary" };
  try {
    for (const [name, value] of [
      ["browser-hardware-evidence.json", { result: "PASS" }],
      ["adapter-attestation.json", { result: "PASS" }],
      ["route-probe.json", { ok: true }],
      ["https-origin-policy.json", readJson("https-origin-policy.json")],
      ["mobile-device-route-readiness.json", { schemaVersion: 1 }],
      ["device-matrix.json", readJson("../device/device-matrix.json")],
      ["host-inventory.json", captureExact(hardwareObservation())],
    ]) {
      writeFileSync(join(root, name), JSON.stringify(value));
    }
    const input = readHostCanaryInput({
      jobRoot: { jobDirectory: root },
      authorization,
    });
    assert.deepEqual(input.inventory.attachedAssetIds, host.attachedAssetIds);

    const incomplete = structuredClone(input.inventory);
    delete incomplete.attachedAssetIds;
    writeFileSync(join(root, "host-inventory.json"), JSON.stringify(incomplete));
    assert.throws(
      () =>
        readHostCanaryInput({
          jobRoot: { jobDirectory: root },
          authorization,
        }),
      /incomplete/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime rejects forbidden stable identifier fields instead of sanitizing them", () => {
  const observed = hardwareObservation();
  observed.attachedAssets[0].serialNumber = "must-not-cross";
  assert.throws(() => captureExact(observed), /stable identifier/u);
});

function captureExact(hardware) {
  return captureHostInventory({
    assetId: hostId,
    platform: "darwin",
    osBuild: "macOS build 25A123",
    displayServer: "WindowServer",
    session: {
      interactive: true,
      locked: false,
      remote: false,
      identifier: "forge3d",
    },
    browsers: [browser],
    tools,
    policy,
    capturedAt: new Date("2026-07-29T08:00:00.000Z"),
    hardware,
    matrix,
    trackpad,
    requireExactHardware: true,
    requireTrackpad: true,
  });
}

function hardwareObservation() {
  return {
    model: host.model,
    cpu: host.cpu,
    gpu: host.gpu,
    ramGiB: host.ramGiB,
    attachedAssets: host.attachedAssetIds.map((assetId) => {
      const asset = matrix.assets.find((candidate) => candidate.assetId === assetId);
      return {
        assetId: asset.assetId,
        model: asset.model,
        appiumId: asset.appiumId,
      };
    }),
  };
}

function readJson(name) {
  return JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), "utf8"));
}
