import { createHash } from "node:crypto";

export function signControllerRecord({
  record,
  signer,
}) {
  assertControllerSigner(signer);
  const canonical = canonicalJson(record);
  const value = signer.sign(canonical, "ieee-p1363-base64url");
  assertSignatureValue(value, "ieee-p1363-base64url");
  return {
    record,
    canonical,
    sha256: createHash("sha256").update(canonical).digest("hex"),
    signature: {
      algorithm: "SHA256withECDSA",
      signingKeyId: signer.signingKeyId,
      encoding: "ieee-p1363-base64url",
      value,
    },
  };
}

export function assertControllerSigner(signer) {
  if (
    signer === null ||
    typeof signer !== "object" ||
    typeof signer.sign !== "function"
  ) {
    throw new Error("opaque controller signer is required");
  }
  assertSigningKeyId(signer.signingKeyId);
}

export function assertSigningKeyId(signingKeyId) {
  if (!/^controller-fw-[a-z0-9-]+-p256-v[1-9][0-9]*$/u.test(signingKeyId ?? "")) {
    throw new Error("controller signing key ID is not checked");
  }
}

export function assertSignatureValue(value, encoding) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_-]+$/u.test(value) ||
    Buffer.from(value, "base64url").toString("base64url") !== value
  ) {
    throw new Error("controller signer returned a malformed signature");
  }
  const bytes = Buffer.from(value, "base64url");
  if (encoding === "ieee-p1363-base64url" && bytes.length !== 64) {
    throw new Error("controller signer returned a malformed P1363 signature");
  }
  if (encoding === "der-base64url" && !isCanonicalDerEcdsa(bytes)) {
    throw new Error("controller signer returned a malformed DER signature");
  }
}

function isCanonicalDerEcdsa(bytes) {
  if (bytes.length < 8 || bytes.length > 72 || bytes[0] !== 0x30) return false;
  if (bytes[1] !== bytes.length - 2 || bytes[2] !== 0x02) return false;
  const rLength = bytes[3];
  const sOffset = 4 + rLength;
  if (
    rLength < 1 ||
    rLength > 33 ||
    sOffset + 2 > bytes.length ||
    bytes[sOffset] !== 0x02
  ) return false;
  const sLength = bytes[sOffset + 1];
  if (sLength < 1 || sLength > 33 || sOffset + 2 + sLength !== bytes.length) {
    return false;
  }
  return canonicalPositiveInteger(bytes.subarray(4, sOffset)) &&
    canonicalPositiveInteger(bytes.subarray(sOffset + 2));
}

function canonicalPositiveInteger(bytes) {
  return (
    (bytes[0] & 0x80) === 0 &&
    !(bytes.length > 1 && bytes[0] === 0 && (bytes[1] & 0x80) === 0)
  );
}

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}
