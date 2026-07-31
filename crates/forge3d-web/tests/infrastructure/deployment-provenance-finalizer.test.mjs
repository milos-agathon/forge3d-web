import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { finalizeDeploymentProvenance } from "../../scripts/finalize-deployment-provenance.mjs";
import { createSignedDeploymentProvenanceReceipt } from "../../../../tools/browser-lab-controller/src/deployment-provenance.mjs";
import { assertJsonSchema } from "../browser/json-schema-validator.mjs";

const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const hostId = "FW-LNX-NV-01";
const keyId = "controller-fw-lnx-nv-01-p256-v1";
const trustedSha = "a".repeat(40);
const workflowSha = "b".repeat(40);
const run = { id: 301, attempt: 2 };
const signedRecord = createSignedDeploymentProvenanceReceipt({
  run,
  hostId,
  trustedSha,
  brokerDeployment: serviceDeployment({
    service: "broker",
    serviceIdentity: "broker:forge3d-browser-lab",
    packageRunId: 101,
    artifactId: 201,
  }),
  controllerDeployment: serviceDeployment({
    service: "controller",
    serviceIdentity: `controller:${hostId}`,
    packageRunId: 102,
    artifactId: 202,
  }),
  privateKey: keys.privateKey,
  signingKeyId: keyId,
  observedAt: new Date("2026-07-31T10:05:00.000Z"),
});
const authorization = {
  record: {
    workflow: { sha: workflowSha },
    run,
    hostId,
    trustedSha,
  },
};
const matrix = {
  hosts: [
    {
      assetId: hostId,
      controller: {
        state: "online",
        signingKeyId: keyId,
        publicJwk: keys.publicKey.export({ format: "jwk" }),
      },
    },
  ],
};
const finalizer = {
  workflowSha,
  run,
  job: "finalize-hardware-evidence",
  environment: "forge3d-trust-observer",
  observedAt: "2026-07-31T10:10:00.000Z",
};

test("hosted finalizer verifies and retains a separate deployment sidecar", () => {
  const result = finalizeDeploymentProvenance({
    signedRecord,
    authorization,
    matrix,
    finalizer,
  });
  assertJsonSchema(
    result,
    JSON.parse(
      readFileSync(
        new URL(
          "./lab-deployment-provenance.schema.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ),
  );
  assert.equal(result.controllerSignature.verified, true);
  assert.equal(result.attestation.verified, true);
  assert.equal(result.broker.packageRun.id, 101);
  assert.equal(result.controller.packageRun.id, 102);
  assert.equal(Object.hasOwn(result, "runner"), false);
});

test("hosted finalizer rejects candidate, host, and workflow substitution", () => {
  for (const changed of [
    {
      authorization: {
        record: {
          ...authorization.record,
          trustedSha: "c".repeat(40),
        },
      },
    },
    {
      authorization: {
        record: {
          ...authorization.record,
          hostId: "FW-LNX-I12-01",
        },
      },
    },
    {
      finalizer: {
        ...finalizer,
        workflowSha: "c".repeat(40),
      },
    },
  ]) {
    assert.throws(() =>
      finalizeDeploymentProvenance({
        signedRecord,
        authorization: changed.authorization ?? authorization,
        matrix,
        finalizer: changed.finalizer ?? finalizer,
      }),
    );
  }
});

function serviceDeployment({
  service,
  serviceIdentity,
  packageRunId,
  artifactId,
}) {
  return {
    schemaVersion: 1,
    recordType: "lab-service-deployment-provenance",
    service,
    serviceIdentity,
    packageRun: {
      id: packageRunId,
      attempt: 1,
      artifact: {
        id: artifactId,
        name: `browser-lab-${service}-${trustedSha}-${packageRunId}-1`,
        digest: `sha256:${"1".repeat(64)}`,
      },
    },
    source: {
      repository: "milos-agathon/forge3d-web",
      targetSha: trustedSha,
      workflowSha,
    },
    packageManifest: {
      sha256: "2".repeat(64),
      attestation: {
        verified: true,
        repository: "milos-agathon/forge3d-web",
        signerWorkflow:
          `milos-agathon/forge3d-web/.github/workflows/browser-lab-${service}.yml`,
        sourceRef: "refs/heads/main",
        sourceDigest: trustedSha,
        denySelfHostedRunners: true,
      },
    },
    archive: {
      name:
        service === "broker"
          ? "browser-lab-broker.tar.gz"
          : "browser-lab-controller-1.0.0.tar.gz",
      sha256: "3".repeat(64),
    },
    configuration: { sha256: "4".repeat(64) },
    protocols: {
      broker: "forge3d-browser-lab-broker/v1",
      cleanup: "forge3d-browser-lab-cleanup/v1",
    },
    administratorVerification: {
      status: "verified",
      method: "github-attestation",
      verifiedAt: "2026-07-31T09:00:00.000Z",
      verifiedBy: "lab-admin",
    },
  };
}
