import { existsSync, readFileSync } from "node:fs";
import { assertSafeLaunchArguments } from "./capture-host-inventory.mjs";
import { canonicalJson } from "./canonical-json.mjs";
import { assertJsonSchema } from "./json-schema-validator.mjs";

const source = new URL("../tests/browser/saf02-conformance.schema.json", import.meta.url);
const packaged = new URL("./saf02-conformance.schema.json", import.meta.url);
const schema = JSON.parse(readFileSync(existsSync(packaged) ? packaged : source, "utf8"));
const sourcePolicy = new URL("../tests/infrastructure/browser-policy.json", import.meta.url);
const packagedPolicy = new URL("./browser-policy.json", import.meta.url);
const browserPolicy = JSON.parse(
  readFileSync(existsSync(packagedPolicy) ? packagedPolicy : sourcePolicy, "utf8"),
);

export function assertExactSafariRoute(route, saf02Route) {
  if (!route || !saf02Route || canonicalJson(route) !== canonicalJson(saf02Route)) {
    throw new Error("Safari route and SAF-02 route must be the same exact authorized route");
  }
}

export function validateSaf02Conformance(proof, expected) {
  assertJsonSchema(proof, schema);
  for (const field of ["lane", "assetId", "hostId", "runId", "jobId", "commit", "packageSha256"]) {
    if (proof.binding[field] !== expected[field]) throw new Error(`SAF-02 proof ${field} does not match its authorization`);
  }
  const application = new URL(expected.applicationUrl);
  const asset = new URL(expected.assetUrl);
  const routeMatch = proof.route.basePath.match(
    /^\/runs\/([1-9][0-9]*)\/([1-9][0-9]*)\/([0-9a-f]{32})\/$/u,
  );
  if (proof.route.applicationOrigin !== application.origin || proof.route.assetOrigin !== asset.origin ||
      proof.route.basePath !== application.pathname || proof.route.basePath !== asset.pathname ||
      proof.route.nonce !== application.pathname.split("/").at(-2) || !routeMatch ||
      Number(routeMatch[1]) !== expected.runId || Number(routeMatch[2]) !== expected.jobId ||
      routeMatch[3] !== proof.route.nonce) throw new Error("SAF-02 proof route is replayed or mismatched");
  const modes = new Set(proof.observers.configureCalls.map(({ alphaMode }) => alphaMode));
  if (!modes.has("opaque") || !modes.has("premultiplied")) throw new Error("SAF-02 proof did not observe both production alpha modes");
  if (proof.render.submittedFramesAfterCamera <= proof.render.submittedFramesBeforeCamera) {
    throw new Error("SAF-02 camera change did not submit a subsequent frame");
  }
  if (!Array.isArray(expected.effectiveLaunchArguments) ||
      proof.environment.effectiveLaunchArguments.length !== expected.effectiveLaunchArguments.length ||
      proof.environment.effectiveLaunchArguments.some((argument, index) => argument !== expected.effectiveLaunchArguments[index])) {
    throw new Error("SAF-02 proof launch arguments do not match authoritative session evidence");
  }
  assertSafeLaunchArguments(expected.effectiveLaunchArguments, browserPolicy);
  if (expected.browser && (expected.browser.name?.toLowerCase() !== "safari" || expected.browser.channel !== "stable")) {
    throw new Error("SAF-02 proof is not shipping stable Safari");
  }
  if (expected.system && expected.system.platform !== "darwin") {
    throw new Error("SAF-02 proof is not macOS Apple Silicon");
  }
  if (expected.adapter && (expected.adapter.isFallbackAdapter !== false || expected.adapter.secureContext !== true || expected.adapter.deviceCreated !== true || expected.adapter.surfacePresented !== true)) {
    throw new Error("SAF-02 adapter proof is incomplete");
  }
  return proof;
}
