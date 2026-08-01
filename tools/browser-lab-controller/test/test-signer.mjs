import { createSign } from "node:crypto";

import { assertSigningKeyId } from "../src/controller-signing.mjs";

export function createTestPrivateKeySigner({ privateKey, signingKeyId }) {
  assertSigningKeyId(signingKeyId);
  return Object.freeze({
    signingKeyId,
    sign(canonical, encoding) {
      if (
        typeof canonical !== "string" ||
        !["der-base64url", "ieee-p1363-base64url"].includes(encoding)
      ) {
        throw new Error("test controller signer request is invalid");
      }
      const signature = createSign("SHA256");
      signature.update(canonical);
      signature.end();
      return signature
        .sign({
          key: privateKey,
          dsaEncoding:
            encoding === "der-base64url" ? "der" : "ieee-p1363",
        })
        .toString("base64url");
    },
  });
}
