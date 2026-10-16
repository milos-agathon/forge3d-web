import { existsSync, readFileSync } from "node:fs";

import { validateFnd07Benchmark } from "./chr03-hardware-proof-validator.mjs";
import { SAF03_STABLE_LANE } from "./saf03-lanes.mjs";
import { assertJsonSchema } from "./json-schema-validator.mjs";

const sourceSchema = new URL("../tests/browser/saf03-safari-proof.schema.json", import.meta.url);
const packagedSchema = new URL("./saf03-safari-proof.schema.json", import.meta.url);
const schema = JSON.parse(readFileSync(existsSync(packagedSchema) ? packagedSchema : sourceSchema, "utf8"));
const VIEW_TOLERANCE = 1e-9;
const BINDING_FIELDS = Object.freeze(["lane", "assetId", "commit", "packageSha256"]);

export function projectSaf03Binding(binding) {
  return Object.fromEntries(BINDING_FIELDS.flatMap((field) =>
    binding && Object.hasOwn(binding, field) ? [[field, binding[field]]] : []));
}

export function validateSaf03SafariProof(proof, expectedBinding = null) {
  assertJsonSchema(proof, schema);
  if (proof.kind !== "forge3d-saf03-safari-acceptance-v1") {
    throw new Error("SAF-03 rejects legacy or unversioned Safari smoke evidence");
  }
  const expected = expectedBinding ?? {};
  for (const [name, value] of Object.entries({
    lane: SAF03_STABLE_LANE.lane,
    assetId: SAF03_STABLE_LANE.assetId,
    platform: SAF03_STABLE_LANE.platform,
    ...expected,
  })) {
    if (proof.binding?.[name] !== value) throw new Error(`SAF-03 proof ${name} does not match its authorized binding`);
  }
  if (proof.browser.name !== "safari" || proof.browser.channel !== "stable" || major(proof.browser.version) < SAF03_STABLE_LANE.minimumMajor ||
      proof.driver.clientName !== "selenium-webdriver" || proof.driver.clientVersion !== "4.35.0" ||
      proof.driver.name !== "safaridriver" || proof.driver.executable !== "/usr/bin/safaridriver" ||
      proof.system.platform !== "darwin" || proof.system.architecture !== "arm64" || major(proof.system.osVersion) !== 26 ||
      !proof.system.osBuild.trim() ||
      proof.secureContext !== true || proof.adapter?.isFallbackAdapter !== false ||
      proof.adapter.secureContext !== true || proof.adapter.deviceCreated !== true ||
      proof.adapter.surfacePresented !== true) {
    throw new Error("SAF-03 stable Safari, Selenium, SafariDriver, macOS, architecture, or secure-context provenance is invalid");
  }
  validateActions(proof.actions);
  validateScreenshot(proof.screenshots.native, "native WebDriver screenshot");
  validateScreenshot(proof.screenshots.viewer, "viewer screenshot API");
  const baseline = proof.lifecycleBaseline;
  validateOwnership(baseline.ownership, "lifecycle baseline");
  const visibilityLast = validateCycles(proof.visibilityCycles, "visibility", false, baseline, {
    sequence: baseline.lastEventSequence,
    submittedFrames: -1,
  });
  validateCycles(proof.bfcacheCycles, "bfcache", true, baseline, visibilityLast);
  const reload = proof.hardReload;
  if (reload.pageshowPersisted !== false || reload.previousDocumentIdentity === reload.documentIdentity ||
      reload.previousViewerIdentity === reload.viewerIdentity || reload.submittedFrameFresh !== true ||
      reload.previousDocumentIdentity !== proof.bfcacheCycles.at(-1).documentIdentityAfter ||
      reload.previousViewerIdentity !== proof.bfcacheCycles.at(-1).viewerIdentityAfter) {
    throw new Error("SAF-03 hard-reload control must be a persisted-false cold document with a fresh viewer frame");
  }
  validateOwnership(reload.ownership, "hard reload");
  validatePixelEvidence(reload.pixels, "hard reload");
  validateOwnership(proof.disposal, "disposal", true);
  validateFnd07Benchmark(proof.benchmark);
  if (!Array.isArray(proof.errors) || proof.errors.length !== 0 ||
      !Array.isArray(proof.errorObservations?.beforeReload) || proof.errorObservations.beforeReload.length !== 0 ||
      !Array.isArray(proof.errorObservations?.reloadBoundary) || proof.errorObservations.reloadBoundary.length !== 0 ||
      !Array.isArray(proof.errorObservations?.afterReload) || proof.errorObservations.afterReload.length !== 0) {
    throw new Error("SAF-03 proof contains runtime or WebGPU errors");
  }
  return proof;
}

export function validateSaf03TechnologyPreviewResult(result, inventory, expectedBinding = null, expectedRoute = null) {
  assertExactKeys(result, ["kind", "binding", "channel", "classification", "required", "replacesStable", "clientVersion", "executable", "driverExecutable", "driverVersion", "version", "browser", "result", "warning", "cleanup", "probe"], "STP result");
  assertExactKeys(result?.binding, ["lane", "assetId", "commit", "packageSha256"], "STP binding");
  const expected = { lane: SAF03_STABLE_LANE.lane, assetId: SAF03_STABLE_LANE.assetId, ...projectSaf03Binding(expectedBinding) };
  for (const [name, value] of Object.entries(expected)) {
    if (result?.binding?.[name] !== value) throw new Error(`SAF-03 STP ${name} does not match its authorized binding`);
  }
  if (result?.kind !== "forge3d-saf03-stp-result-v1" || result.channel !== "technology-preview" ||
      result.classification !== "probe" || result.required !== false || result.replacesStable !== false ||
      result.clientVersion !== "4.35.0" || !["PASS", "PRODUCT_FAILURE", "ABSENT"].includes(result.result)) {
    throw new Error("SAF-03 Technology Preview result is malformed");
  }
  const installed = inventory?.browsers?.find(({ id }) => id === "safari-technology-preview");
  assertExactKeys(result.cleanup, ["notStarted", "sessionDeleted", "driverStopped", "processAbsent", "ok"], "STP cleanup");
  if (result.result === "ABSENT") {
    if (installed || result.executable !== null || result.driverExecutable !== null || result.driverVersion !== null || result.version !== null ||
        result.browser !== null || typeof result.warning !== "string" || result.warning.length === 0 || result.probe !== null ||
        result.cleanup?.notStarted !== true || result.cleanup.sessionDeleted !== null ||
        result.cleanup.driverStopped !== null || result.cleanup.processAbsent !== true || result.cleanup.ok !== true) {
      throw new Error("SAF-03 STP absence does not match inventory");
    }
  } else if (!installed || result.executable !== installed.executable || result.version !== installed.version) {
    throw new Error("SAF-03 STP runtime does not match the separate checked inventory entry");
  } else {
    const expectedDriverExecutable = inventory.tools?.safariTechnologyPreviewDriverPath;
    const expectedDriverVersion = inventory.tools?.safariTechnologyPreviewDriverVersion;
    const retainedBrowser = result.browser !== null;
    if (retainedBrowser &&
        (result.browser.name !== "safari" || result.browser.channel !== "technology-preview" ||
         result.browser.version !== installed.version || result.driverExecutable !== expectedDriverExecutable ||
         result.driverVersion !== expectedDriverVersion || result.cleanup.notStarted !== false ||
         result.cleanup.sessionDeleted !== true || result.cleanup.driverStopped !== true ||
         result.cleanup.processAbsent !== true || result.cleanup.ok !== true)) {
      throw new Error("SAF-03 retained STP browser lacks exact provenance and cleanup");
    }
    if (result.result === "PASS" && (!retainedBrowser || result.warning !== null)) {
      throw new Error("SAF-03 passing STP runtime does not retain its checked browser");
    }
    if (result.cleanup.notStarted === true) {
      if (result.result !== "PRODUCT_FAILURE" || result.driverExecutable !== null || result.driverVersion !== null ||
          retainedBrowser || result.cleanup.sessionDeleted !== null || result.cleanup.driverStopped !== null ||
          result.cleanup.processAbsent !== true || result.cleanup.ok !== true) {
        throw new Error("SAF-03 STP preflight failure state is contradictory");
      }
    } else if (result.cleanup.notStarted === false) {
      if (result.driverExecutable !== expectedDriverExecutable || result.driverVersion !== expectedDriverVersion ||
          result.cleanup.driverStopped !== true || result.cleanup.processAbsent !== true || result.cleanup.ok !== true ||
          (retainedBrowser ? result.cleanup.sessionDeleted !== true : ![true, null].includes(result.cleanup.sessionDeleted))) {
        throw new Error("SAF-03 STP launched cleanup is unproven or contradictory");
      }
    } else {
      throw new Error("SAF-03 STP cleanup start state is invalid");
    }
  }
  if (result.result === "PASS") validateStpProbe(result.probe, result.binding, expectedRoute);
  else if (result.probe !== null) throw new Error("SAF-03 non-passing STP result cannot retain a passing probe");
  if (result.result === "PRODUCT_FAILURE" && (typeof result.warning !== "string" || result.warning.length === 0)) {
    throw new Error("SAF-03 STP product failure must be retained as a warning");
  }
  return result;
}

export function validateSaf03EvidenceEnvelope({
  proof,
  technologyPreview,
  inventory,
  browser,
  driver,
  system,
  adapter,
  route,
  expectedBinding,
}) {
  validateSaf03SafariProof(proof, expectedBinding);
  const stableInventory = inventory?.browsers?.find(({ id }) => id === "safari-stable");
  const authorizedRoute = route?.applicationUrl;
  let parsedRoute;
  try { parsedRoute = new URL(authorizedRoute); } catch { throw new Error("SAF-03 authorized fixture route is invalid"); }
  if (parsedRoute.protocol !== "https:" || parsedRoute.username || parsedRoute.password || parsedRoute.search || parsedRoute.hash) {
    throw new Error("SAF-03 authorized fixture route is not trusted HTTPS");
  }
  if (!stableInventory || stableInventory.channel !== "stable" || stableInventory.classification !== "required" ||
      proof.browser.name !== browser?.name || proof.browser.channel !== browser.channel || proof.browser.version !== browser.version ||
      proof.browser.version !== stableInventory.version || proof.driver.name !== driver?.name ||
      proof.driver.version !== driver.version || proof.driver.version !== inventory?.tools?.safaridriverVersion ||
      proof.driver.executable !== inventory?.tools?.safaridriverPath ||
      proof.system.platform !== system?.platform || proof.system.osVersion !== system.osVersion ||
      proof.system.osBuild !== system.osBuild || proof.system.architecture !== system.architecture ||
      proof.system.platform !== inventory?.platform || proof.system.osVersion !== inventory.osVersion ||
      proof.system.osBuild !== inventory.osBuild || proof.system.architecture !== inventory.architecture ||
      proof.adapter.isFallbackAdapter !== adapter?.isFallbackAdapter ||
      proof.adapter.secureContext !== adapter.secureContext || proof.adapter.deviceCreated !== adapter.deviceCreated ||
      proof.adapter.surfacePresented !== adapter.surfacePresented) {
    throw new Error("SAF-03 nested proof provenance does not match the outer record and checked inventory");
  }
  validateSaf03TechnologyPreviewResult(technologyPreview, inventory, expectedBinding, authorizedRoute);
  return { proof, technologyPreview };
}

function validateActions(actions) {
  for (const name of ["orbit", "pan", "wheelZoom"]) {
    const action = actions?.[name];
    if (action?.action !== name || action.native !== true || action.changed !== true ||
        !viewChanged(action.before.view, action.after.view) || action.after.submittedFrames <= action.before.submittedFrames) {
      throw new Error(`SAF-03 ${name} requires its own native before/after camera and frame evidence`);
    }
    validatePixelEvidence(action.before.pixels, `${name} before`);
    validatePixelEvidence(action.after.pixels, `${name} after`);
    if (action.before.pixels.sha256 === action.after.pixels.sha256) {
      throw new Error(`SAF-03 ${name} requires changed decoded pixel evidence`);
    }
  }
  const reset = actions?.reset;
  if (reset?.action !== "reset" || reset.native !== true || reset.key !== "Home" || reset.matchedInitial !== true ||
      !viewChanged(reset.before.view, reset.after.view) || !viewsClose(reset.after.view, reset.initialView, VIEW_TOLERANCE) ||
      reset.tolerance !== VIEW_TOLERANCE || reset.after.submittedFrames <= reset.before.submittedFrames) {
    throw new Error("SAF-03 reset must restore every initial camera field within the fixed tolerance");
  }
  validatePixelEvidence(reset.before.pixels, "reset before");
  validatePixelEvidence(reset.after.pixels, "reset after");
  if (reset.before.pixels.sha256 === reset.after.pixels.sha256) {
    throw new Error("SAF-03 reset requires changed decoded pixel evidence");
  }
  const resize = actions?.resize;
  if (resize?.action !== "resize" || resize.fixtureControl !== "#resize" || resize.native !== true ||
      resize.cssBefore.width === resize.cssAfter.width || resize.cssBefore.height !== resize.cssAfter.height ||
      resize.backingBefore.width === resize.backingAfter.width || resize.submittedFrameFresh !== true) {
    throw new Error("SAF-03 resize must use the fixture control and prove CSS, backing, and a fresh frame");
  }
  validatePixelEvidence(resize.pixelsBefore, "resize before");
  validatePixelEvidence(resize.pixelsAfter, "resize after");
  if (resize.pixelsBefore.sha256 === resize.pixelsAfter.sha256) {
    throw new Error("SAF-03 resize requires changed decoded pixel evidence");
  }
}

function validateCycles(cycles, label, persisted, baseline, initialState) {
  if (!Array.isArray(cycles) || cycles.length !== 30) throw new Error(`SAF-03 requires exactly 30 ${label} cycles`);
  const baselineDocument = baseline.documentIdentity;
  const baselineViewer = baseline.viewerIdentity;
  let lastSequence = initialState.sequence;
  let lastSubmittedFrames = initialState.submittedFrames;
  cycles.forEach((cycle, index) => {
    if (cycle.cycle !== index + 1 || cycle.documentIdentityBefore !== baselineDocument || cycle.documentIdentityAfter !== baselineDocument ||
        cycle.viewerIdentityBefore !== baselineViewer || cycle.viewerIdentityAfter !== baselineViewer ||
        cycle.submittedFrameFresh !== true || cycle.submittedFramesAfter <= cycle.submittedFramesBefore ||
        cycle.submittedFramesBefore < lastSubmittedFrames) {
      throw new Error(`SAF-03 ${label} cycles must be ordered, identity-stable, and freshly rendered`);
    }
    validateOwnership(cycle.ownership, `${label} cycle ${index + 1}`, false, baseline.ownership);
    validatePixelEvidence(cycle.pixels, `${label} cycle ${index + 1}`);
    const events = persisted ? cycle.events : [cycle.hiddenEvent, cycle.visibleEvent];
    for (const event of events) {
      if (!Number.isInteger(event.sequence) || event.sequence <= lastSequence) {
        throw new Error(`SAF-03 ${label} lifecycle events must be monotonic, paired, and never reused`);
      }
      lastSequence = event.sequence;
    }
    lastSubmittedFrames = cycle.submittedFramesAfter;
    if (persisted) {
      if (events.length !== 2 || events[0].type !== "pagehide" || events[1].type !== "pageshow" ||
          events[0].persisted !== true || events[1].persisted !== true) {
        throw new Error("SAF-03 BFCache cycles require paired persisted-true pagehide/pageshow events");
      }
    } else if (events[0].type !== "visibilitychange" || events[0].state !== "hidden" ||
        events[1].type !== "visibilitychange" || events[1].state !== "visible") {
      throw new Error("SAF-03 visibility cycles require actual hidden/visible event pairs");
    }
  });
  return { sequence: lastSequence, submittedFrames: lastSubmittedFrames };
}

function validateOwnership(value, label, disposed = false, stableExpected = null) {
  const expected = disposed
    ? { activeRuntimes: 0, ownedListeners: 0, activeObservers: 0, activePointers: 0, pendingAnimationFrame: false, ownedAnimationFrameCount: 0 }
    : { activeRuntimes: 1, activeObservers: 1, activePointers: 0 };
  if (!value || Object.entries(expected).some(([key, expectedValue]) => value[key] !== expectedValue) ||
      (!disposed && (value.ownedListeners < 1 || value.ownedAnimationFrameCount > 1)) ||
      (stableExpected && Object.keys(stableExpected).some((key) => value[key] !== stableExpected[key]))) {
    throw new Error(`SAF-03 ${label} ownership is not exact or bounded`);
  }
}

function validateStpProbe(probe, binding, expectedRoute) {
  assertExactKeys(probe, ["schemaVersion", "binding", "route", "submittedFrames", "screenshot", "errors"], "STP probe");
  assertExactKeys(probe.binding, BINDING_FIELDS, "STP probe binding");
  if (probe.schemaVersion !== 1 || BINDING_FIELDS.some((field) => probe.binding[field] !== binding[field]) ||
      !Number.isInteger(probe.submittedFrames) || probe.submittedFrames < 1 ||
      !Array.isArray(probe.errors) || probe.errors.length !== 0) {
    throw new Error("SAF-03 STP probe is not bound to the retained result");
  }
  let route;
  try { route = new URL(probe.route); } catch { throw new Error("SAF-03 STP probe route is invalid"); }
  if (route.protocol !== "https:" || route.username || route.password || route.search || route.hash) {
    throw new Error("SAF-03 STP probe route is not trusted HTTPS");
  }
  if (expectedRoute !== null && probe.route !== expectedRoute) {
    throw new Error("SAF-03 STP probe route does not match the authorized fixture route");
  }
  validateScreenshot(probe.screenshot, "STP viewer screenshot API");
}

function validateScreenshot(value, label) {
  if (value?.mimeType !== "image/png" || !/^[0-9a-f]{64}$/u.test(value.sha256 ?? "") ||
      !Number.isInteger(value.byteLength) || value.byteLength < 24 || !Number.isInteger(value.width) || value.width < 1 ||
      !Number.isInteger(value.height) || value.height < 1) throw new Error(`SAF-03 ${label} is not a decoded PNG`);
  validatePixelEvidence(value.pixels, label);
}

function validatePixelEvidence(value, label) {
  if (!value || value.decoded !== true || value.nonBlank !== true || !Number.isInteger(value.sampleCount) || value.sampleCount < 16 ||
      !Number.isInteger(value.terrainPixelCount) || value.terrainPixelCount < 1 || !Number.isFinite(value.lumaMinimum) ||
      !Number.isFinite(value.lumaMaximum) || value.lumaMaximum - value.lumaMinimum < 0.01 ||
      !/^[0-9a-f]{64}$/u.test(value.sha256 ?? "")) throw new Error(`SAF-03 ${label} lacks decoded terrain pixels`);
}

function viewsClose(left, right, tolerance) {
  const leftValues = [...left.target, left.distance, left.yawDegrees, left.pitchDegrees, left.fovYDegrees, left.near, left.far];
  const rightValues = [...right.target, right.distance, right.yawDegrees, right.pitchDegrees, right.fovYDegrees, right.near, right.far];
  return leftValues.length === rightValues.length && leftValues.every((value, index) => Math.abs(value - rightValues[index]) <= tolerance);
}

function viewChanged(left, right) {
  return !viewsClose(left, right, VIEW_TOLERANCE);
}

function major(value) {
  const parsed = Number.parseInt(String(value).split(".")[0], 10);
  return Number.isInteger(parsed) ? parsed : -1;
}

function assertExactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) {
    throw new Error(`SAF-03 ${label} shape is not closed`);
  }
}
