import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createNativeControllerSigningProvider,
  SIGNING_PROVIDER_PROTOCOL,
} from "../src/native-signing-provider.mjs";

const signingKeyId = "controller-fw-win-nv-01-p256-v1";

test("native signer requires the pinned Windows CNG non-exportable key", () => {
  withProviderFile(({ path, sha256 }) => {
    const calls = [];
    const provider = createNativeControllerSigningProvider({
      executablePath: path,
      executableSha256: sha256,
      signingKeyId,
      platform: "win32",
      execute: (executable, args, options) => {
        calls.push({
          executable,
          args,
          input: options.input?.toString("utf8"),
          stdio: options.stdio,
        });
        if (args[0] === "describe") return JSON.stringify(description());
        return JSON.stringify({
          schemaVersion: 1,
          protocolVersion: SIGNING_PROVIDER_PROTOCOL,
          signingKeyId,
          algorithm: "SHA256withECDSA",
          encoding: "ieee-p1363-base64url",
          value: Buffer.alloc(64, 7).toString("base64url"),
        });
      },
    });
    const value = provider.sign('{"checked":true}', "ieee-p1363-base64url");
    assert.equal(Buffer.from(value, "base64url").length, 64);
    assert.equal(calls[1].input, '{"checked":true}');
    assert.deepEqual(calls[1].stdio, ["pipe", "pipe", "pipe"]);
    assert.deepEqual(calls[1].args, [
      "sign",
      "--key-id",
      signingKeyId,
      "--algorithm",
      "SHA256withECDSA",
      "--encoding",
      "ieee-p1363-base64url",
    ]);
  });
});

test("native signer never surfaces provider stderr", () => {
  withProviderFile(({ path, sha256 }) => {
    assert.throws(
      () =>
        createNativeControllerSigningProvider({
          executablePath: path,
          executableSha256: sha256,
          signingKeyId,
          platform: "win32",
          execute: () => {
            const error = new Error("provider failed: PRIVATE-KEY-MATERIAL");
            error.stderr = Buffer.from("PRIVATE-KEY-MATERIAL");
            throw error;
          },
        }),
      (error) => {
        assert.equal(error.message, "native controller signing provider describe failed");
        assert.equal(error.cause, undefined);
        assert.equal(error.message.includes("PRIVATE-KEY-MATERIAL"), false);
        return true;
      },
    );
  });
});

test("native signer rejects exportable, wrong-backend, and substituted providers", () => {
  withProviderFile(({ path, sha256 }) => {
    for (const override of [
      { exportable: true },
      { backend: "macos-keychain-nonexportable" },
    ]) {
      assert.throws(
        () =>
          createNativeControllerSigningProvider({
            executablePath: path,
            executableSha256: sha256,
            signingKeyId,
            platform: "win32",
            execute: () => JSON.stringify({ ...description(), ...override }),
          }),
        /not a checked non-exportable key/u,
      );
    }
    const provider = createNativeControllerSigningProvider({
      executablePath: path,
      executableSha256: sha256,
      signingKeyId,
      platform: "win32",
      execute: () => JSON.stringify(description()),
    });
    writeFileSync(path, "substituted-provider", { mode: 0o700 });
    assert.throws(
      () => provider.sign("{}", "der-base64url"),
      /provider digest changed/u,
    );
  });
});

function description() {
  return {
    schemaVersion: 1,
    protocolVersion: SIGNING_PROVIDER_PROTOCOL,
    signingKeyId,
    algorithm: "SHA256withECDSA",
    curve: "P-256",
    backend: "windows-cng-nonexportable",
    exportable: false,
  };
}

function withProviderFile(callback) {
  const directory = mkdtempSync(join(tmpdir(), "forge3d-native-signer-"));
  const path = join(directory, "provider");
  try {
    writeFileSync(path, "reviewed-provider", { mode: 0o700 });
    callback({
      path,
      sha256: createHash("sha256").update("reviewed-provider").digest("hex"),
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
