import { existsSync, readFileSync } from "node:fs";

import { canonicalJson } from "./canonical-json.mjs";
import { validateHardwareProofPayload } from "./chr03-hardware-proof-validator.mjs";
import { FFX03_LANES, assertFfx03BrowserVersion, resolveFfx03Lane } from "./ffx03-lanes.mjs";
import { assertJsonSchema } from "./json-schema-validator.mjs";

const sourceSchema = new URL("../tests/browser/ffx03-hardware-proof.schema.json", import.meta.url);
const packagedSchema = new URL("./ffx03-hardware-proof.schema.json", import.meta.url);
const proofSchema = JSON.parse(readFileSync(existsSync(packagedSchema) ? packagedSchema : sourceSchema, "utf8"));
const sourceWorkloadSchema = new URL("../tests/browser/chr03-hardware-proof.schema.json", import.meta.url);
const packagedWorkloadSchema = new URL("./chr03-hardware-proof.schema.json", import.meta.url);
const workloadSchema = JSON.parse(JSON.stringify(JSON.parse(readFileSync(existsSync(packagedWorkloadSchema)
  ? packagedWorkloadSchema : sourceWorkloadSchema, "utf8"))));
workloadSchema.properties.kind.const = "forge3d-ffx03-firefox-workload-v1";
workloadSchema.properties.binding.properties.lane.enum = Object.keys(FFX03_LANES);
workloadSchema.properties.binding.properties.assetId.enum = [...new Set(Object.values(FFX03_LANES).map((lane) => lane.assetId))];
workloadSchema.properties.visibility.properties.cycleCount.const = 1;
workloadSchema.properties.screenshot.required.push("pixels");
const sourceAdapterSchema = new URL("../tests/browser/adapter-attestation.schema.json", import.meta.url);
const packagedAdapterSchema = new URL("./adapter-attestation.schema.json", import.meta.url);
const adapterSchema = JSON.parse(readFileSync(existsSync(packagedAdapterSchema)
  ? packagedAdapterSchema : sourceAdapterSchema, "utf8"));

export function validateFfx03HardwareProof(proof, expected = null) {
  assertJsonSchema(proof, proofSchema);
  exact(proof, ["schemaVersion", "kind", "classification", "required", "experimental", "binding", "browser",
    "driver", "system", "launch", "configuration", "adapter", "workload", "errors", "cleanup"], "FFX-03 proof");
  exact(proof.binding, ["lane", "assetId", "platform", "architecture", "channel", "commit", "packageSha256"], "FFX-03 binding");
  const contract = resolveFfx03Lane({ ...proof.binding, required: proof.required });
  if (!contract.required || proof.classification !== "required" || proof.experimental !== false ||
      !/^[0-9a-f]{40}$/u.test(proof.binding.commit) || !/^[0-9a-f]{64}$/u.test(proof.binding.packageSha256)) {
    throw new Error("FFX-03 stable proof classification or binding is invalid");
  }
  if (expected) for (const field of ["lane", "assetId", "platform", "architecture", "commit", "packageSha256"])
    if (proof.binding[field] !== expected[field]) throw new Error(`FFX-03 proof ${field} does not match authorized evidence`);

  exact(proof.browser, ["name", "channel", "version"], "FFX-03 browser");
  if (proof.browser.name !== "firefox" || proof.browser.channel !== contract.channel ||
      proof.browser.channel !== proof.binding.channel) throw new Error("FFX-03 browser channel is inconsistent");
  assertFfx03BrowserVersion(proof.browser.version, contract);
  exact(proof.driver, ["name", "version", "executable", "clientName", "clientVersion"], "FFX-03 driver");
  if (proof.driver.name !== "selenium-firefox" || proof.driver.version !== "0.36.0" ||
      proof.driver.clientName !== "selenium-webdriver" || proof.driver.clientVersion !== "4.35.0" ||
      typeof proof.driver.executable !== "string" || !absolute(proof.driver.executable)) {
    throw new Error("FFX-03 pinned Selenium/geckodriver provenance is invalid");
  }
  exact(proof.system, ["platform", "architecture", "osBuild"], "FFX-03 system");
  if (proof.system.platform !== contract.platform || proof.system.architecture !== contract.architecture || !text(proof.system.osBuild))
    throw new Error("FFX-03 observed system provenance is invalid");
  validateLaunch(proof.launch, contract);
  validateConfiguration(proof.configuration, contract);
  validateAdapter(proof.adapter, proof.binding, proof.launch.arguments);
  if (proof.adapter?.secureContext !== true || proof.adapter.isFallbackAdapter !== false ||
      proof.adapter.deviceCreated !== true || proof.adapter.surfacePresented !== true) {
    throw new Error("FFX-03 adapter evidence is incomplete");
  }
  exact(proof.workload, ["schemaVersion", "kind", "binding", "behaviors", "driver", "visibility", "terrainSource",
    "screenshot", "lifecycleCycles", "errors", "benchmark", "systemInfo"], "FFX-03 workload");
  assertJsonSchema(proof.workload, workloadSchema);
  if (proof.workload.kind !== "forge3d-ffx03-firefox-workload-v1" ||
      canonicalJson(proof.workload.binding) !== canonicalJson(pick(proof.binding, ["lane", "assetId", "commit", "packageSha256"])))
    throw new Error("FFX-03 workload is borrowed or misbound");
  validateClosedWorkload(proof.workload);
  validateHardwareProofPayload(proof.workload, { visibilityCycles: 1, requireDecodedPixels: true });
  if (proof.errors.length !== 0 || proof.workload.errors.length !== 0) throw new Error("FFX-03 proof contains observed errors");
  exact(proof.cleanup, ["sessionDeleted", "driverStopped", "driverAbsent", "browserAbsent", "ok"], "FFX-03 cleanup");
  if (Object.values(proof.cleanup).some((value) => value !== true)) throw new Error("FFX-03 cleanup was not completely observed");
  return proof;
}

function validateClosedWorkload(workload) {
  if (workload.schemaVersion !== 1) throw new Error("FFX-03 workload schemaVersion must be 1");
  exact(workload.binding, ["lane", "assetId", "commit", "packageSha256"], "FFX-03 workload binding");
  exact(workload.behaviors, ["orbit", "pan", "wheelZoom", "pointerCapture", "keyboard", "autoResize",
    "visibilityResume", "terrainSource", "screenshot", "disposal"], "FFX-03 behaviors");
  exact(workload.driver, ["orbitChanged", "panChanged", "wheelChanged", "pointerCapture", "keyboard", "autoResize"],
    "FFX-03 native driver");
  exact(workload.driver.pointerCapture, ["pointerId", "capturedPointerId", "releasedPointerId", "captured",
    "outsideMoveChanged", "released", "activePointersAfter"], "FFX-03 pointer capture");
  exact(workload.driver.keyboard, ["orbit", "pan", "zoomIn", "zoomOut", "reset"], "FFX-03 keyboard");
  for (const observation of Object.values(workload.driver.keyboard)) exact(observation, ["key", "changed"], "FFX-03 key");
  exact(workload.driver.autoResize, ["observerActive", "dimensionsChanged", "submittedFrame"], "FFX-03 resize");
  exact(workload.visibility, ["source", "cycleCount", "hiddenObserved", "visibleObserved", "submittedEveryCycle"],
    "FFX-03 visibility");
  exact(workload.terrainSource, ["api", "url", "crossOrigin", "width", "height", "byteLength", "progressEvents",
    "completed", "submittedFrame"], "FFX-03 terrain");
  if (!Array.isArray(workload.terrainSource.progressEvents)) throw new Error("FFX-03 terrain progress is invalid");
  for (const event of workload.terrainSource.progressEvents) exact(event, ["loaded", "total", "done"], "FFX-03 terrain progress");
  exact(workload.screenshot, ["mimeType", "byteLength", "sha256", "width", "height", "pixels"], "FFX-03 screenshot");
  exact(workload.screenshot.pixels, ["decoded", "nonBlank"], "FFX-03 screenshot pixels");
  if (!Array.isArray(workload.lifecycleCycles)) throw new Error("FFX-03 lifecycle cycles are invalid");
  for (const cycle of workload.lifecycleCycles) {
    exact(cycle, ["cycle", "runtimeIdentity", "submittedFrames", "afterDispose"], "FFX-03 lifecycle cycle");
    exact(cycle.afterDispose, ["ownedListeners", "activeObservers", "activePointers", "activeRuntimes",
      "pendingAnimationFrame", "ownedAnimationFrameCount"], "FFX-03 disposal");
  }
  exact(workload.systemInfo, ["available", "diagnosticOnly", "value", "unavailableReason"], "FFX-03 SystemInfo");
  if (workload.systemInfo.available !== false || workload.systemInfo.diagnosticOnly !== true ||
      workload.systemInfo.value !== null || !text(workload.systemInfo.unavailableReason)) {
    throw new Error("FFX-03 Firefox SystemInfo evidence is invalid");
  }
}

export function validateFfx03ProbeOutcome(record, expected = null) {
  exact(record, ["schemaVersion", "kind", "classification", "required", "experimental", "outcome", "binding",
    "browser", "driver", "system", "launch", "configuration", "route", "adapter", "diagnostic", "cleanup"], "FFX-03 probe outcome");
  if (record.schemaVersion !== 1 || record.kind !== "forge3d-ffx03-firefox-nightly-probe-v1" ||
      record.classification !== "probe" || record.required !== false || record.experimental !== true ||
      !["PROBE_PASS", "UNAVAILABLE", "PRODUCT_FAILURE"].includes(record.outcome))
    throw new Error("FFX-03 Nightly result discriminator is invalid");
  const contract = resolveFfx03Lane({ ...record.binding, required: false });
  exact(record.binding, ["lane", "assetId", "platform", "architecture", "channel", "commit", "packageSha256"], "FFX-03 probe binding");
  if (!contract.experimental || record.binding.channel !== "nightly" ||
      !/^[0-9a-f]{40}$/u.test(record.binding.commit) || !/^[0-9a-f]{64}$/u.test(record.binding.packageSha256))
    throw new Error("FFX-03 probe is not an authorized Nightly lane");
  if (expected) for (const field of ["lane", "assetId", "platform", "architecture", "commit", "packageSha256"])
    if (record.binding[field] !== expected[field]) throw new Error(`FFX-03 probe ${field} does not match authorization`);
  validateConfiguration(record.configuration, contract);
  exact(record.browser, ["name", "channel", "version"], "FFX-03 probe browser");
  if (record.browser.name !== "firefox" || record.browser.channel !== "nightly")
    throw new Error("FFX-03 probe browser identity is invalid");
  assertFfx03BrowserVersion(record.browser.version, contract);
  exact(record.driver, ["name", "version", "executable", "clientName", "clientVersion"], "FFX-03 probe driver");
  if (record.driver.name !== "selenium-firefox" || record.driver.version !== "0.36.0" ||
      record.driver.clientName !== "selenium-webdriver" || record.driver.clientVersion !== "4.35.0" ||
      !absolute(record.driver.executable)) throw new Error("FFX-03 probe driver identity is invalid");
  exact(record.system, ["platform", "architecture", "osBuild"], "FFX-03 probe system");
  if (record.system.platform !== contract.platform || record.system.architecture !== contract.architecture ||
      !text(record.system.osBuild) || !/^https:\/\//u.test(record.route ?? ""))
    throw new Error("FFX-03 probe system or route provenance is invalid");
  validateLaunch(record.launch, contract);
  if (record.outcome === "PROBE_PASS") validateAdapter(record.adapter, record.binding, record.launch.arguments);
  if (record.outcome !== "PROBE_PASS" && record.adapter !== null) throw new Error("unsuccessful FFX-03 probe may not fabricate adapter evidence");
  if (record.outcome !== "PROBE_PASS" && !text(record.diagnostic)) throw new Error("unsuccessful FFX-03 probe requires a diagnostic");
  exact(record.cleanup, ["sessionDeleted", "driverStopped", "driverAbsent", "browserAbsent", "ok"], "FFX-03 cleanup");
  if (Object.values(record.cleanup).some((value) => value !== true)) throw new Error("FFX-03 Nightly cleanup was not proven");
  return record;
}

function validateLaunch(launch, contract) {
  exact(launch, ["observed", "source", "browserProcessId", "executable", "arguments"], "FFX-03 launch");
  if (launch.observed !== true || launch.source !== `${contract.platform}-live-browser-process` ||
      !Number.isInteger(launch.browserProcessId) || launch.browserProcessId < 1 || !absolute(launch.executable) ||
      !Array.isArray(launch.arguments) || launch.arguments.some((value) => typeof value !== "string") ||
      launch.arguments.some((value) => /ignore-certificate-errors|allow-system-access|unsafe-webgpu/iu.test(value))) {
    throw new Error("FFX-03 live launch observation is unsafe or incomplete");
  }
}

function validateAdapter(adapter, binding, launchArguments) {
  assertJsonSchema(adapter, adapterSchema);
  if (adapter.assetId !== binding.assetId || adapter.commit !== binding.commit ||
      adapter.packageSha256 !== binding.packageSha256 || adapter.secureContext !== true ||
      adapter.navigatorGpu !== true || adapter.adapterInfoAvailable !== true ||
      adapter.isFallbackAdapter !== false || adapter.deviceCreated !== true ||
      adapter.surfaceCreated !== true || adapter.surfacePresented !== true || adapter.lumaChanged !== true ||
      !adapter.limits || Object.keys(adapter.limits).length === 0 ||
      (launchArguments !== null && canonicalJson(adapter.effectiveLaunchArguments) !== canonicalJson(launchArguments))) {
    throw new Error("FFX-03 adapter evidence is incomplete or misbound");
  }
}

function validateConfiguration(configuration, contract) {
  exact(configuration, ["source", "freshProfile", "profilePathSha256", "requestedOverrides",
    "observedWebGpuUserOverrides", "afterWorkload"], "FFX-03 configuration");
  if (configuration.source !== "geckodriver-generated-profile-observation" || configuration.freshProfile !== true ||
      !/^[0-9a-f]{64}$/u.test(configuration.profilePathSha256)) throw new Error("FFX-03 profile observation is invalid");
  const expected = contract.channel === "nightly" ? { "dom.webgpu.enabled": true } : {};
  if (canonicalJson(configuration.requestedOverrides) !== canonicalJson(expected) ||
      canonicalJson(configuration.observedWebGpuUserOverrides) !== canonicalJson(expected) ||
      canonicalJson(configuration.afterWorkload) !== canonicalJson(expected))
    throw new Error("FFX-03 WebGPU preference provenance is invalid");
}

function exact(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== [...fields].sort().join(",")) throw new Error(`${label} has unknown or missing fields`);
}
function pick(value, fields) { return Object.fromEntries(fields.map((field) => [field, value[field]])); }
function absolute(value) { return typeof value === "string" && /^(?:\/|[A-Za-z]:\\)/u.test(value); }
function text(value) { return typeof value === "string" && value.trim() !== ""; }

export { FFX03_LANES };
