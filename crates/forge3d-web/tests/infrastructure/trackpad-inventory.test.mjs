import assert from "node:assert/strict";
import test from "node:test";

import { captureTrackpadInventory } from "../../scripts/capture-trackpad-inventory.mjs";

const usbProfile = {
  SPUSBDataType: [
    {
      _name: "USB 3.1 Bus",
      _items: [
        {
          _name: "Magic Trackpad",
          model_id: "A3120",
          firmware_version: "3.1.2",
          serial_num: "DO-NOT-EMIT",
          location_id: "0x00100000",
        },
      ],
    },
  ],
};
const bluetoothProfile = {
  SPBluetoothDataType: [
    {
      _name: "Magic Trackpad",
      device_model: "A3120",
      device_firmwareVersion: "3.1.2",
      device_batteryLevel: "87%",
      device_address: "AA-BB-CC-DD-EE-FF",
      device_minorType: "Trackpad",
    },
  ],
};

test("emits only the allowlisted trackpad inventory fields", () => {
  const inventory = captureTrackpadInventory({
    usbProfile,
    bluetoothProfile,
    capturedAt: new Date("2026-07-28T12:00:00.000Z"),
  });
  assert.deepEqual(Object.keys(inventory), [
    "assetId",
    "model",
    "firmware",
    "transport",
    "batteryState",
    "capturedAt",
    "topology",
  ]);
  assert.equal(inventory.assetId, "FW-TRACKPAD-01");
  assert.equal(inventory.firmware, "3.1.2");
  assert.equal(inventory.batteryState, "87%");
  assert.equal(inventory.topology.hubPresent, false);
  const serialized = JSON.stringify(inventory);
  for (const forbidden of [
    "DO-NOT-EMIT",
    "AA-BB-CC-DD-EE-FF",
    "serial",
    "address",
    "location",
  ]) {
    assert.equal(serialized.toLowerCase().includes(forbidden.toLowerCase()), false);
  }
});

test("fails when the charging topology includes a hub", () => {
  const profile = structuredClone(usbProfile);
  profile.SPUSBDataType[0]._items = [
    {
      _name: "USB-C Hub",
      _items: profile.SPUSBDataType[0]._items,
    },
  ];
  assert.throws(
    () =>
      captureTrackpadInventory({
        usbProfile: profile,
        bluetoothProfile,
      }),
    /direct cable/u,
  );
});

test("fails unless both USB and Bluetooth captures contain the fixed asset", () => {
  assert.throws(
    () =>
      captureTrackpadInventory({
        usbProfile,
        bluetoothProfile: {},
      }),
    /both USB and Bluetooth/u,
  );
});

test("rejects a different Magic Trackpad model", () => {
  const olderUsb = structuredClone(usbProfile);
  olderUsb.SPUSBDataType[0]._items[0].model_id = "A1535";
  const olderBluetooth = structuredClone(bluetoothProfile);
  olderBluetooth.SPBluetoothDataType[0].device_model = "A1535";
  assert.throws(
    () =>
      captureTrackpadInventory({
        usbProfile: olderUsb,
        bluetoothProfile: olderBluetooth,
      }),
    /fixed USB-C model A3120/u,
  );
});
