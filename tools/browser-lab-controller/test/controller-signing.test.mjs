import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";

import {
  canonicalJson,
  signControllerRecord,
} from "../src/controller-signing.mjs";
import { createTestPrivateKeySigner } from "./test-signer.mjs";

test("controller signs RFC8785-compatible canonical bytes with P-256 SHA-256", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const record = {
    z: 2,
    a: { beta: true, alpha: "value" },
    list: [3, null, "x"],
  };
  const signed = signControllerRecord({
    record,
    signer: createTestPrivateKeySigner({
      privateKey,
      signingKeyId: "controller-fw-lnx-nv-01-p256-v1",
    }),
  });
  assert.equal(
    signed.canonical,
    '{"a":{"alpha":"value","beta":true},"list":[3,null,"x"],"z":2}',
  );
  assert.equal(signed.signature.algorithm, "SHA256withECDSA");
  assert.equal(
    verify(
      "SHA256",
      Buffer.from(canonicalJson(record)),
      {
        key: publicKey,
        dsaEncoding: "ieee-p1363",
      },
      Buffer.from(signed.signature.value, "base64url"),
    ),
    true,
  );
});
