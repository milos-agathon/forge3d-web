import { existsSync, readFileSync } from "node:fs";

import { assertSafeLaunchArguments } from "./capture-host-inventory.mjs";
import { hasMeasuredLumaPresentation } from "./join-adapter-attestation.mjs";
import { validateHardwareProofPayload } from "./chr03-hardware-proof-validator.mjs";
import { CHR04_LANES } from "./chr04-lanes.mjs";
import { assertJsonSchema } from "./json-schema-validator.mjs";

const sourceSchema = new URL("../tests/browser/chr04-hardware-proof.schema.json", import.meta.url);
const packagedSchema = new URL("./chr04-hardware-proof.schema.json", import.meta.url);
const proofSchema = JSON.parse(readFileSync(existsSync(packagedSchema) ? packagedSchema : sourceSchema, "utf8"));

export function validateChr04HardwareProofContract(proof, expectedBinding = null) {
  assertJsonSchema(proof, proofSchema);
  const lane = CHR04_LANES[proof.binding?.lane];
  if (!lane || lane.assetId !== proof.binding.assetId || lane.platform !== proof.binding.platform) {
    throw new Error("CHR-04 lane does not match its exact checked hardware asset and platform");
  }
  if (expectedBinding !== null) {
    for (const name of ["lane", "assetId", "platform", "commit", "packageSha256"]) {
      if (proof.binding[name] !== expectedBinding[name]) throw new Error(`CHR-04 proof ${name} does not match the authorized binding`);
    }
  }
  validateHardwareProofPayload(proof);
  validateEdgeAcceptance(proof.edgeAcceptance);
  return proof;
}

export function validateChr04EdgeEvidence({ proof, expectedBinding, browser, driver, system, effectiveLaunchArguments, adapter, browserPolicy }) {
  validateChr04HardwareProofContract(proof, expectedBinding);
  if (browser?.name !== "msedge" || browser.channel !== "stable" || !edgeVersion(browser.version) ||
      driver?.name !== "playwright-edge" || !playwrightVersion(driver.version)) {
    throw new Error("CHR-04 requires exact branded stable Edge and Playwright Edge provenance");
  }
  if (system?.platform !== expectedBinding.platform || !String(system.osBuild ?? "").trim()) {
    throw new Error("CHR-04 system platform or build does not match the authorized lane");
  }
  if (expectedBinding.platform === "linux" && system.displayServer !== "GNOME Wayland") {
    throw new Error("CHR-04 Linux evidence requires observed GNOME Wayland");
  }
  if (!Array.isArray(effectiveLaunchArguments)) throw new Error("CHR-04 launch arguments were not observed");
  assertSafeLaunchArguments(effectiveLaunchArguments, browserPolicy ?? { prohibitedLaunchArguments: DEFAULT_PROHIBITED_ARGUMENTS });
  if (adapter?.isFallbackAdapter !== false || adapter.secureContext !== true || adapter.deviceCreated !== true ||
      adapter.surfacePresented !== true || !hasMeasuredLumaPresentation(adapter)) {
    throw new Error("CHR-04 requires nonfallback hardware presentation");
  }
  return proof;
}

const DEFAULT_PROHIBITED_ARGUMENTS = [
  "--disable-gpu", "--disable-gpu-compositing", "--enable-unsafe-webgpu", "--ignore-gpu-blocklist", "--ignore-certificate-errors",
  "--use-angle", "--use-gl", "--use-vulkan", "--use-webgpu-adapter", "--use-webgpu-power-preference",
  "--disable-software-rasterizer", "--enable-webgpu-developer-features",
];

function edgeVersion(value) {
  return typeof value === "string" && /^[1-9]\d*\.\d+\.\d+\.\d+$/u.test(value);
}

function playwrightVersion(value) {
  return typeof value === "string" && /^[1-9]\d*\.\d+\.\d+$/u.test(value);
}

function validateEdgeAcceptance(value) {
  if (value?.kind !== "forge3d-chr04-edge-browser-diagnostics-v1" || value.synthetic !== true ||
      value.physicalPolicyProof !== false || value.touch?.injectedAtBrowserBoundary !== true ||
      value.touch.pointerType !== "touch" || value.touch.pointerId !== 73 || value.touch.viewChanged !== true ||
      value.touch.activePointersAfter !== 0 || value.touch.disposed !== true) {
    throw new Error("CHR-04 synthetic touch observation is incomplete");
  }
  const missing = value.unsupported?.missingApi;
  const adapter = value.unsupported?.nullAdapter;
  const unrelated = value.unsupported?.unrelated;
  if (!unsupportedCase(missing, "WEBGPU_UNAVAILABLE", null, false) ||
      !unsupportedCase(adapter, "WEBGPU_ADAPTER_UNAVAILABLE", true, true) ||
      unrelated?.code !== "WASM_LOAD_FAILED" || unrelated.status !== "WASM_LOAD_FAILED" ||
      unrelated.unsupportedVisible !== false) {
    throw new Error("CHR-04 unsupported UI diagnostic observation is incomplete");
  }
}

function unsupportedCase(value, code, intercepted, recovered) {
  return value?.thrownCode === code && value.publicCode === code && value.status === "unsupported" &&
    value.unsupportedVisible === true && value.adapterIntercepted === intercepted &&
    value.hasBypassAdvice === false && value.bypassLinks === 0 &&
    (recovered ? value.recovered === true : !Object.hasOwn(value, "recovered"));
}
