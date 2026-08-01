import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

import {
  assertSignatureValue,
  assertSigningKeyId,
} from "./controller-signing.mjs";

export const SIGNING_PROVIDER_PROTOCOL =
  "forge3d-controller-signing-provider/v1";

const platformBackends = Object.freeze({
  win32: "windows-cng-nonexportable",
  darwin: "macos-keychain-nonexportable",
  linux: "linux-pkcs11-nonexportable",
});

export function createNativeControllerSigningProvider({
  executablePath,
  executableSha256,
  signingKeyId,
  platform = process.platform,
  execute = execFileSync,
}) {
  assertSigningKeyId(signingKeyId);
  if (
    !isAbsolute(executablePath ?? "") ||
    !/^[0-9a-f]{64}$/u.test(executableSha256 ?? "") ||
    typeof execute !== "function" ||
    !Object.hasOwn(platformBackends, platform)
  ) {
    throw new Error("native controller signing provider configuration is invalid");
  }
  const expectedBackend = platformBackends[platform];
  const invoke = (operation, args, input = undefined) => {
    assertExecutableDigest(executablePath, executableSha256);
    let output;
    try {
      output = execute(executablePath, [operation, ...args], {
        ...(input === undefined ? {} : { input: Buffer.from(input, "utf8") }),
        encoding: "utf8",
        maxBuffer: 16 * 1024,
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      throw new Error(`native controller signing provider ${operation} failed`);
    }
    try {
      return JSON.parse(output);
    } catch {
      throw new Error("native controller signing provider returned invalid JSON");
    }
  };

  const description = invoke("describe", ["--key-id", signingKeyId]);
  assertExactKeys(description, [
    "schemaVersion",
    "protocolVersion",
    "signingKeyId",
    "algorithm",
    "curve",
    "backend",
    "exportable",
  ]);
  if (
    description.schemaVersion !== 1 ||
    description.protocolVersion !== SIGNING_PROVIDER_PROTOCOL ||
    description.signingKeyId !== signingKeyId ||
    description.algorithm !== "SHA256withECDSA" ||
    description.curve !== "P-256" ||
    description.backend !== expectedBackend ||
    description.exportable !== false
  ) {
    throw new Error("native controller signing key is not a checked non-exportable key");
  }

  return Object.freeze({
    signingKeyId,
    backend: expectedBackend,
    sign(canonical, encoding) {
      if (
        typeof canonical !== "string" ||
        canonical.length === 0 ||
        !["der-base64url", "ieee-p1363-base64url"].includes(encoding)
      ) {
        throw new Error("native controller signing request is invalid");
      }
      const receipt = invoke(
        "sign",
        [
          "--key-id",
          signingKeyId,
          "--algorithm",
          "SHA256withECDSA",
          "--encoding",
          encoding,
        ],
        canonical,
      );
      assertExactKeys(receipt, [
        "schemaVersion",
        "protocolVersion",
        "signingKeyId",
        "algorithm",
        "encoding",
        "value",
      ]);
      if (
        receipt.schemaVersion !== 1 ||
        receipt.protocolVersion !== SIGNING_PROVIDER_PROTOCOL ||
        receipt.signingKeyId !== signingKeyId ||
        receipt.algorithm !== "SHA256withECDSA" ||
        receipt.encoding !== encoding
      ) {
        throw new Error("native controller signing receipt binding is invalid");
      }
      assertSignatureValue(receipt.value, encoding);
      return receipt.value;
    },
  });
}

function assertExecutableDigest(path, expectedSha256) {
  const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (actual !== expectedSha256) {
    throw new Error("native controller signing provider digest changed");
  }
}

function assertExactKeys(value, expected) {
  const actual = Object.keys(value ?? {}).sort();
  const wanted = [...expected].sort();
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error("native controller signing provider response is not closed");
  }
}
