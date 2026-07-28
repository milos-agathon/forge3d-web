import { verify as verifySignature } from "node:crypto";

import { canonicalJson } from "./canonical-json.mjs";

export const BROKER_PROTOCOL_VERSION = "forge3d-browser-lab-broker/v1";
export const CLEANUP_PROTOCOL_VERSION = "forge3d-browser-lab-cleanup/v1";
export const FIXED_REPOSITORY = Object.freeze({
  id: 1259761852,
  fullName: "milos-agathon/forge3d-web",
});
export const FIXED_RUNNER_GROUP_ID = 1;
export const FIXED_WORK_FOLDER = "_work";
const GITHUB_PLATFORM_LABELS = new Set([
  "self-hosted",
  "Linux",
  "Windows",
  "macOS",
  "X64",
  "ARM64",
  "ARM",
]);

const cleanupReasons = new Set([
  "terminal",
  "launch-failure",
  "start-timeout",
  "online-unassigned",
  "quarantine-release",
]);

export function validateJitRequest(request) {
  assertExactKeys(request, [
    "protocolVersion",
    "authorizationDigest",
    "requestNonce",
    "controller",
    "signature",
  ]);
  assertEqual(request.protocolVersion, BROKER_PROTOCOL_VERSION, "JIT protocol version");
  validateCommonRequest(request);
  return request;
}

export function validateCleanupRequest(request) {
  assertExactKeys(request, [
    "protocolVersion",
    "authorizationDigest",
    "requestNonce",
    "controller",
    "reason",
    "listenerStop",
    "workRootWipe",
    "signature",
  ]);
  assertEqual(
    request.protocolVersion,
    CLEANUP_PROTOCOL_VERSION,
    "cleanup protocol version",
  );
  validateCommonRequest(request);
  if (!cleanupReasons.has(request.reason)) {
    throw new Error(`unsupported cleanup reason: ${request.reason}`);
  }
  if (request.listenerStop !== null) {
    assertExactKeys(request.listenerStop, [
      "attempted",
      "stopped",
      "processId",
      "observedAt",
    ]);
    if (
      request.listenerStop.attempted !== true ||
      typeof request.listenerStop.stopped !== "boolean" ||
      !Number.isInteger(request.listenerStop.processId) ||
      request.listenerStop.processId < 1 ||
      !Number.isFinite(Date.parse(request.listenerStop.observedAt))
    ) {
      throw new Error("cleanup listener-stop proof is invalid");
    }
  }
  if (request.workRootWipe !== null) {
    assertExactKeys(request.workRootWipe, [
      "attempted",
      "wiped",
      "workFolder",
      "observedAt",
    ]);
    if (
      request.workRootWipe.attempted !== true ||
      typeof request.workRootWipe.wiped !== "boolean" ||
      request.workRootWipe.workFolder !== FIXED_WORK_FOLDER ||
      !Number.isFinite(Date.parse(request.workRootWipe.observedAt))
    ) {
      throw new Error("cleanup work-root-wipe proof is invalid");
    }
  }
  if (
    request.reason === "quarantine-release" &&
    (request.listenerStop?.stopped !== true ||
      request.workRootWipe?.wiped !== true)
  ) {
    throw new Error(
      "quarantine release requires listener-stop and work-root-wipe proof",
    );
  }
  if (
    request.reason !== "quarantine-release" &&
    request.workRootWipe !== null
  ) {
    throw new Error("work-root-wipe proof is only valid for quarantine release");
  }
  return request;
}

export function verifyControllerRequest({
  request,
  matrix,
  mtlsIdentity,
  expectedHostAssetId,
}) {
  const host = matrix.hosts.find(
    (candidate) => candidate.assetId === request.controller.assetId,
  );
  if (!host) {
    throw new Error("controller asset is not in the checked matrix");
  }
  if (
    host.assetId !== expectedHostAssetId ||
    host.controller.identity !== mtlsIdentity ||
    request.controller.identity !== mtlsIdentity ||
    request.controller.signingKeyId !== host.controller.signingKeyId
  ) {
    throw new Error("mTLS, authorization, request, and matrix controller identities disagree");
  }
  const publicJwk = host.controller.publicJwk;
  if (
    host.state !== "active" ||
    host.controller.state !== "online" ||
    publicJwk?.kty !== "EC" ||
    publicJwk?.crv !== "P-256" ||
    publicJwk.d !== undefined
  ) {
    throw new Error("controller is not active with a checked P-256 public key");
  }
  const signedBody = structuredClone(request);
  delete signedBody.signature;
  const valid = verifySignature(
    "sha256",
    Buffer.from(canonicalJson(signedBody), "utf8"),
    { key: publicJwk, format: "jwk", dsaEncoding: "der" },
    Buffer.from(request.signature.value, "base64url"),
  );
  if (
    request.signature.algorithm !== "SHA256withECDSA" ||
    request.signature.signingKeyId !== host.controller.signingKeyId ||
    !valid
  ) {
    throw new Error("controller request signature is invalid");
  }
  return host;
}

export function deriveJitRequest(authorization, host) {
  if (
    authorization.repository?.id !== FIXED_REPOSITORY.id ||
    authorization.repository?.fullName !== FIXED_REPOSITORY.fullName ||
    authorization.hostAssetId !== host.assetId ||
    authorization.hwLabel !== host.requiredLabels[1] ||
    !/^[0-9a-f]{32}$/u.test(authorization.runnerNonce ?? "")
  ) {
    throw new Error("authorization cannot derive the fixed runner identity");
  }
  return {
    name: `${host.assetId}-${authorization.runnerNonce}`,
    runner_group_id: FIXED_RUNNER_GROUP_ID,
    work_folder: FIXED_WORK_FOLDER,
    labels: [
      "forge3d-web",
      authorization.hwLabel,
      `jit-${authorization.runnerNonce}`,
    ],
  };
}

export function verifyReturnedRunner(response, derived) {
  if (
    response.status !== 201 ||
    typeof response.body?.encoded_jit_config !== "string" ||
    response.body.encoded_jit_config.length < 20 ||
    !Number.isInteger(response.body.runner?.id) ||
    response.body.runner.id < 1 ||
    response.body.runner.name !== derived.name
  ) {
    throw new Error("GitHub JIT response did not match the derived runner request");
  }
  const labels = (response.body.runner.labels ?? []).map((label) =>
    typeof label === "string" ? label : label.name,
  );
  for (const required of derived.labels) {
    if (!labels.includes(required)) {
      throw new Error(`GitHub JIT response is missing custom label ${required}`);
    }
  }
  for (const label of labels) {
    if (!derived.labels.includes(label) && !GITHUB_PLATFORM_LABELS.has(label)) {
      throw new Error(`GitHub JIT response contains unexpected label ${label}`);
    }
  }
  return {
    runnerId: response.body.runner.id,
    runnerName: response.body.runner.name,
    labels,
    encodedJitConfig: response.body.encoded_jit_config,
  };
}

export function validateRunnerIdentity(runner, record) {
  const labels = (runner.labels ?? []).map((label) =>
    typeof label === "string" ? label : label.name,
  );
  const unexpectedLabel = labels.find(
    (label) =>
      !record.customLabels.includes(label) &&
      !GITHUB_PLATFORM_LABELS.has(label),
  );
  if (
    runner.id !== record.runnerId ||
    runner.name !== record.runnerName ||
    record.customLabels.some((label) => !labels.includes(label)) ||
    unexpectedLabel !== undefined
  ) {
    throw new Error("live runner ID, name, or labels disagree with issuance ledger");
  }
}

function validateCommonRequest(request) {
  if (!/^[0-9a-f]{64}$/u.test(request.authorizationDigest ?? "")) {
    throw new Error("authorization digest must be 64 lowercase hex characters");
  }
  if (!/^[0-9a-f]{32}$/u.test(request.requestNonce ?? "")) {
    throw new Error("request nonce must contain 128 bits");
  }
  assertExactKeys(request.controller, [
    "assetId",
    "identity",
    "signingKeyId",
  ]);
  assertExactKeys(request.signature, [
    "algorithm",
    "signingKeyId",
    "value",
  ]);
  if (
    !/^FW-(?:MAC|WIN|LNX)-[A-Z0-9-]+$/u.test(request.controller.assetId ?? "") ||
    request.controller.identity !== `controller:${request.controller.assetId}` ||
    !/^[A-Za-z0-9_-]+$/u.test(request.signature.value ?? "")
  ) {
    throw new Error("controller identity or signature encoding is invalid");
  }
}

function assertExactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("protocol value must be an object");
  }
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (canonicalJson(actual) !== canonicalJson(sortedExpected)) {
    throw new Error(
      `protocol fields mismatch: expected ${sortedExpected.join(", ")}, got ${actual.join(", ")}`,
    );
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} mismatch`);
  }
}
