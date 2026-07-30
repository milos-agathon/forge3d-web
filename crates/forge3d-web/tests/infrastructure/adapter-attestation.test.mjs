import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  captureHostGpuEvidence,
  sanitizeMacDisplayEvidence,
} from "../../scripts/capture-host-gpu-evidence.mjs";
import { joinAdapterAttestation } from "../../scripts/join-adapter-attestation.mjs";
import { assertJsonSchema } from "../browser/json-schema-validator.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(root, "..", "..");
const matrix = JSON.parse(readFileSync(join(root, "hardware-matrix.json"), "utf8"));
const schema = JSON.parse(
  readFileSync(join(packageRoot, "tests/browser/adapter-attestation.schema.json"), "utf8"),
);
const binding = {
  runId: 100,
  jobId: 200,
  assetId: "FW-LNX-NV-01",
  commit: "a".repeat(40),
  packageSha256: "b".repeat(64),
};
const page = {
  schemaVersion: 1,
  ...binding,
  navigatorGpu: true,
  adapterInfoAvailable: true,
  adapterInfo: {
    vendor: "",
    architecture: "",
    device: "",
    description: "",
    isFallbackAdapter: false,
  },
  isFallbackAdapter: false,
  deviceAdapterInfo: null,
  limits: { maxTextureDimension2D: 16384 },
  deviceCreated: true,
  surfaceCreated: true,
  surfacePresented: true,
  presentedFrameLuma: 0.42,
  lumaChanged: true,
  effectiveLaunchArguments: [],
};
const linuxInventory = {
  schemaVersion: 1,
  assetId: binding.assetId,
  platform: "linux",
  osBuild: "Linux 6.8.0 checked",
  headed: true,
  session: {
    interactive: true,
    locked: false,
    remote: false,
    identifier: "7",
  },
  capturedAt: "2026-07-29T10:00:00.000Z",
};
const host = captureHostGpuEvidence({
  binding,
  platform: "linux",
  matrix,
  inventory: linuxInventory,
  commandEvidence: {
    lspci: "NVIDIA Corporation GA104 GeForce RTX 3070",
    nvidiaSmi: "NVIDIA GeForce RTX 3070, 555.42.02",
    loginctl: "Type=wayland\nActive=yes\nRemote=no",
    sessionType: "wayland",
    waylandDisplay: "wayland-0",
    driver: "NVIDIA 555.42.02 Vulkan",
  },
});

test("page adapter attestation matches its strict schema", () => {
  assertJsonSchema(page, schema);
});

test("required attestation joins exact run/job/asset/commit/package bindings", () => {
  const record = joinAdapterAttestation(page, host);
  assert.equal(record.result, "PASS");
  assert.equal(record.binding.assetId, binding.assetId);
});

test("fallback and missing fallback information fail before browser acceptance", () => {
  assert.throws(
    () => joinAdapterAttestation({ ...page, isFallbackAdapter: true }, host),
    /fallback adapter/u,
  );
  assert.throws(
    () =>
      joinAdapterAttestation(
        { ...page, adapterInfoAvailable: false, isFallbackAdapter: null },
        host,
      ),
    /ATTESTATION_UNAVAILABLE/u,
  );
});

test("device, surface, luma, host GPU, session, and exact binding are all required", () => {
  assert.throws(
    () => joinAdapterAttestation({ ...page, deviceCreated: false }, host),
    /device, and surface creation/u,
  );
  assert.throws(
    () => joinAdapterAttestation({ ...page, lumaChanged: false }, host),
    /luma-changing/u,
  );
  assert.throws(
    () => joinAdapterAttestation(page, { ...host, expectedGpuPresent: false }),
    /expected physical GPU/u,
  );
  assert.throws(
    () => joinAdapterAttestation(page, { ...host, jobId: 201 }),
    /binding mismatch: jobId/u,
  );
});

test("Linux evidence rejects missing Wayland/driver data and old NVIDIA drivers", () => {
  const commandEvidence = host.commandEvidence;
  assert.throws(
    () =>
      captureHostGpuEvidence({
        binding,
        platform: "linux",
        matrix,
        inventory: linuxInventory,
        commandEvidence: { ...commandEvidence, sessionType: "x11" },
      }),
    /headed Wayland/u,
  );
  assert.throws(
    () =>
      captureHostGpuEvidence({
        binding,
        platform: "linux",
        matrix,
        inventory: linuxInventory,
        commandEvidence: {
          ...commandEvidence,
          nvidiaSmi: "NVIDIA GeForce RTX 3070, 550.90.07",
        },
      }),
    /May 2024/u,
  );
});

test("Intel Linux host evidence does not require NVIDIA tooling", () => {
  const intelBinding = { ...binding, assetId: "FW-LNX-I12-01" };
  const record = captureHostGpuEvidence({
    binding: intelBinding,
    platform: "linux",
    matrix,
    inventory: { ...linuxInventory, assetId: "FW-LNX-I12-01" },
    commandEvidence: {
      lspci: "Intel Corporation Alder Lake-P Integrated Graphics Controller",
      nvidiaSmi: "",
      loginctl: "Type=wayland\nActive=yes\nRemote=no",
      sessionType: "wayland",
      waylandDisplay: "wayland-0",
      driver: "Mesa Intel Iris Xe",
      driverDate: "2026-06-01",
    },
  });
  assert.equal(record.expectedGpuPresent, true);
});

test("attached mobile evidence remains bound to its fixed controller host", () => {
  const mobileBinding = { ...binding, assetId: "FW-IOS-OLD-01" };
  const record = captureHostGpuEvidence({
    binding: mobileBinding,
    hostId: "FW-MAC-M2-01",
    platform: "darwin",
    matrix,
    inventory: {
      ...linuxInventory,
      assetId: "FW-MAC-M2-01",
      platform: "darwin",
      osBuild: "Darwin 25.0.0 checked",
      session: {
        interactive: true,
        locked: false,
        remote: false,
        identifier: "forge3d-lab",
      },
    },
    commandEvidence: {
      systemProfiler: {
        SPDisplaysDataType: [{ sppci_model: "Apple M2" }],
      },
    },
  });
  assert.equal(record.assetId, "FW-IOS-OLD-01");
  assert.equal(record.hostId, "FW-MAC-M2-01");
  assert.throws(
    () =>
      captureHostGpuEvidence({
        binding: mobileBinding,
        hostId: "FW-WIN-I12-01",
        platform: "win32",
        matrix,
        inventory: {
          ...linuxInventory,
          assetId: "FW-WIN-I12-01",
          platform: "win32",
          osBuild: "Microsoft Windows NT 10.0.26200.0",
          session: {
            interactive: true,
            locked: false,
            remote: false,
            identifier: "FORGE3D\\lab",
          },
        },
        commandEvidence: { videoControllers: [{ Name: "Intel Iris Xe" }] },
      }),
    /not attached/u,
  );
});

test("macOS host GPU capture removes display serial and device identifiers", () => {
  assert.deepEqual(
    sanitizeMacDisplayEvidence({
      SPDisplaysDataType: [
        {
          sppci_model: "Apple M2",
          sppci_vendor: "Apple",
          spdisplays_metal: "Supported",
          spdisplays_ndrvs: [
            {
              "_name": "Personal display",
              "spdisplays_display-serial-number": "SECRET-SERIAL",
            },
          ],
          "_spdisplays_device-id": "0x1234",
        },
      ],
    }),
    {
      SPDisplaysDataType: [
        {
          sppci_model: "Apple M2",
          sppci_vendor: "Apple",
          spdisplays_metal: "Supported",
        },
      ],
    },
  );
});
