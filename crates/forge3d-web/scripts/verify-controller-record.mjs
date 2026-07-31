import { createPublicKey, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256Hex } from "./canonical-json.mjs";
import { assertNoStableIdentifiers } from "./capture-host-inventory.mjs";
import { assertJsonSchema } from "../tests/browser/json-schema-validator.mjs";
import { validateDiagnosticRetentionReceipt } from "../../../tools/browser-lab-controller/src/diagnostic-retention.mjs";

const hostCanarySchema = JSON.parse(
  readFileSync(
    new URL("../tests/infrastructure/host-lab-canary.schema.json", import.meta.url),
    "utf8",
  ),
);
const installationSchema = JSON.parse(
  readFileSync(
    new URL(
      "../tests/infrastructure/lab-service-installation.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const hostInventorySchema = JSON.parse(
  readFileSync(
    new URL("../tests/infrastructure/host-inventory.schema.json", import.meta.url),
    "utf8",
  ),
);
const mobileRouteSchema = JSON.parse(
  readFileSync(
    new URL(
      "../tests/infrastructure/mobile-device-route-readiness.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

export function verifyControllerRecord({ signed, matrix, recordType }) {
  const record = signed.record;
  if (recordType !== "host-lab-canary") {
    throw new Error("unsupported controller record type");
  }
  assertJsonSchema(record, hostCanarySchema);
  assertJsonSchema(record.inventory, hostInventorySchema);
  assertJsonSchema(record.installations.controller, installationSchema);
  assertJsonSchema(record.installations.broker, installationSchema);
  if (record.mobileRouteReadiness !== null) {
    assertJsonSchema(record.mobileRouteReadiness, mobileRouteSchema);
  }
  validateDiagnosticRetentionReceipt(record.diagnosticRetention, {
    authorizationDigest: record.authorization.sha256,
    hostId: record.hostId,
    run: { id: record.runId, attempt: record.runAttempt },
    runnerNonce: record.diagnosticRetention.runnerNonce,
  });
  assertNoStableIdentifiers(record);
  assertNoSecretEvidenceKeys(record);
  const host = matrix.hosts.find(
    (candidate) => candidate.assetId === record.hostId,
  );
  if (
    record.recordType !== recordType ||
    host?.controller?.state !== "online" ||
    !host.controller.publicJwk ||
    signed.signature?.signingKeyId !== host.controller.signingKeyId ||
    signed.signature.algorithm !== "SHA256withECDSA" ||
    signed.signature.encoding !== "ieee-p1363-base64url" ||
    signed.canonical !== canonicalJson(record) ||
    signed.sha256 !== sha256Hex(record)
  ) {
    throw new Error("controller record identity, key, or canonical digest is invalid");
  }
  const valid = verify(
    "SHA256",
    Buffer.from(signed.canonical),
    {
      key: createPublicKey({ key: host.controller.publicJwk, format: "jwk" }),
      dsaEncoding: "ieee-p1363",
    },
    Buffer.from(signed.signature.value, "base64url"),
  );
  if (!valid) throw new Error("controller record signature is invalid");
  return record;
}

export function assertNoSecretEvidenceKeys(value, path = "$") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoSecretEvidenceKeys(entry, `${path}[${index}]`),
    );
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
    if (
      normalized === "key" ||
      normalized === "token" ||
      normalized === "secret" ||
      normalized === "credential" ||
      normalized.includes("privatekey") ||
      normalized.includes("serialnumber") ||
      normalized === "serial" ||
      normalized.includes("udid") ||
      normalized.endsWith("address") ||
      normalized.includes("locationid")
    ) {
      throw new Error(`controller record contains prohibited evidence key: ${path}.${key}`);
    }
    assertNoSecretEvidenceKeys(nested, `${path}.${key}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const signed = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const matrix = JSON.parse(readFileSync(process.argv[3], "utf8"));
  const record = verifyControllerRecord({
    signed,
    matrix,
    recordType: process.argv[4],
  });
  writeFileSync(process.argv[5], `${canonicalJson(record)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(JSON.stringify({ ok: true, recordType: record.recordType }));
}
