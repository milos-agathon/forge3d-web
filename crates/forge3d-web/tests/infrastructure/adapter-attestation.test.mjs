import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { captureHostGpuEvidence } from "../../scripts/capture-host-gpu-evidence.mjs";
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
const host = captureHostGpuEvidence({
  binding,
  platform: "linux",
  matrix,
  commandEvidence: {
    lspci: "NVIDIA Corporation GA104 GeForce RTX 3070",
    nvidiaSmi: "NVIDIA GeForce RTX 3070, 555.42.02",
    loginctl: "Type=wayland\nActive=yes\nRemote=no",
    sessionType: "wayland",
    waylandDisplay: "wayland-0",
    driver: "NVIDIA 555.42.02 Vulkan",
    driverDate: "2024-06-01",
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
        commandEvidence: { ...commandEvidence, driverDate: "2024-04-30" },
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
