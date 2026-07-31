import { createPublicKey, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256Hex } from "./canonical-json.mjs";

export function verifyControllerRecord({ signed, matrix, recordType }) {
  const record = signed.record;
  if (
    ![
      "host-lab-canary",
      "lab-service-deployment-provenance-receipt",
    ].includes(recordType)
  ) {
    throw new Error("unsupported controller record type");
  }
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
