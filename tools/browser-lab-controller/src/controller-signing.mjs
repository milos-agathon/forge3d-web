import { createHash, createSign } from "node:crypto";

export function signControllerRecord({
  record,
  privateKey,
  signingKeyId,
}) {
  if (!/^controller-fw-[a-z0-9-]+-p256-v[1-9][0-9]*$/u.test(signingKeyId ?? "")) {
    throw new Error("controller signing key ID is not checked");
  }
  const canonical = canonicalJson(record);
  const signer = createSign("SHA256");
  signer.update(canonical);
  signer.end();
  const signature = signer.sign({
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return {
    record,
    canonical,
    sha256: createHash("sha256").update(canonical).digest("hex"),
    signature: {
      algorithm: "SHA256withECDSA",
      signingKeyId,
      encoding: "ieee-p1363-base64url",
      value: signature.toString("base64url"),
    },
  };
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
