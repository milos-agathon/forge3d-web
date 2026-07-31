import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import test from "node:test";

import { ControllerBrokerClient } from "../src/broker-client.mjs";
import { canonicalJson } from "../src/controller-signing.mjs";

test("controller broker client signs mTLS issue and cleanup requests", async () => {
  const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const requests = [];
  const client = new ControllerBrokerClient({
    endpoint: "https://broker.internal:8443",
    hostId: "FW-LNX-NV-01",
    signingKeyId: "controller-fw-lnx-nv-01-p256-v1",
    privateKey: keys.privateKey,
    tls: { key: "key", cert: "cert", ca: "ca" },
    transport: async (url, body, tls) => {
      requests.push({ url, body, tls });
      return url.endsWith("/v1/jit-config")
        ? {
            protocolVersion: "forge3d-browser-lab-broker/v1",
            authorizationDigest: body.authorizationDigest,
            runnerId: 9,
            runnerName: "runner",
            encodedJitConfig: "opaque",
            deployment: { component: "broker" },
          }
        : {
            authorizationDigest: body.authorizationDigest,
            deletionResult: "deleted",
            deployment: { component: "broker" },
          };
    },
  });
  await client.issue({
    authorizationDigest: "a".repeat(64),
    requestNonce: "b".repeat(32),
  });
  await client.cleanup({
    authorizationDigest: "a".repeat(64),
    requestNonce: "c".repeat(32),
    reason: "terminal",
    listenerStop: {
      attempted: true,
      stopped: true,
      processId: 41,
      observedAt: "2026-07-29T10:20:00.000Z",
    },
  });
  assert.equal(requests.length, 2);
  assert.ok(requests[0].url.endsWith("/v1/jit-config"));
  assert.ok(requests[1].url.endsWith("/v1/cleanup-runner"));
  for (const { body } of requests) {
    const { signature, ...record } = body;
    const verifier = createVerify("SHA256");
    verifier.update(canonicalJson(record));
    verifier.end();
    assert.equal(
      verifier.verify(
        keys.publicKey,
        Buffer.from(signature.value, "base64url"),
      ),
      true,
    );
  }
});
