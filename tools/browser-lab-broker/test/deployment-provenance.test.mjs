import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { assertJsonSchema } from "../../../crates/forge3d-web/tests/browser/json-schema-validator.mjs";
import { createBrokerPackageManifest } from "../scripts/create-package-manifest.mjs";
import { canonicalJson } from "../src/canonical-json.mjs";
import {
  verifyBrokerDeploymentProvenance,
} from "../src/deployment-provenance.mjs";
import {
  createBrokerRequestHandler,
  loadInstalledBrokerDeploymentProvenance,
} from "../src/server.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

test("strict schemas and runtime bind broker package and administrator receipt", () => {
  const directory = mkdtempSync(join(tmpdir(), "forge3d-broker-deployment-"));
  try {
    const archivePath = join(directory, "browser-lab-broker.tar.gz");
    writeFileSync(archivePath, "broker archive");
    const packageManifest = createBrokerPackageManifest({
      repositoryRoot,
      archivePath,
      targetSha: "a".repeat(40),
      workflowSha: "b".repeat(40),
    });
    const packageManifestBytes = Buffer.from(canonicalJson(packageManifest));
    const installationReceipt = brokerReceipt(
      packageManifest,
      packageManifestBytes,
    );
    assertJsonSchema(
      packageManifest,
      readSchema("broker-package-manifest.schema.json"),
    );
    assertJsonSchema(
      installationReceipt,
      readSchema("lab-service-deployment-provenance.schema.json"),
    );
    assert.deepEqual(
      verifyBrokerDeploymentProvenance({
        packageManifest,
        packageManifestBytes,
        installationReceipt,
      }),
      installationReceipt,
    );
    const leapDateWithoutMilliseconds = structuredClone(installationReceipt);
    leapDateWithoutMilliseconds.administratorVerification.verifiedAt =
      "2024-02-29T23:59:59Z";
    assert.deepEqual(
      verifyBrokerDeploymentProvenance({
        packageManifest,
        packageManifestBytes,
        installationReceipt: leapDateWithoutMilliseconds,
      }),
      leapDateWithoutMilliseconds,
    );

    const changed = structuredClone(installationReceipt);
    changed.protocols.cleanup = "forge3d-browser-lab-cleanup/v2";
    assert.throws(
      () =>
        verifyBrokerDeploymentProvenance({
          packageManifest,
          packageManifestBytes,
          installationReceipt: changed,
        }),
      /deployment provenance is invalid/u,
    );
    const wrongAttempt = structuredClone(installationReceipt);
    wrongAttempt.packageRun.attempt += 1;
    assert.throws(
      () =>
        verifyBrokerDeploymentProvenance({
          packageManifest,
          packageManifestBytes,
          installationReceipt: wrongAttempt,
        }),
      /deployment provenance is invalid/u,
    );
    for (const verifiedAt of [
      "2026-02-30T10:00:00.000Z",
      "2026-01-01T24:00:00.000Z",
      "2025-02-29T10:00:00.000Z",
    ]) {
      const invalidTimestamp = structuredClone(installationReceipt);
      invalidTimestamp.administratorVerification.verifiedAt = verifiedAt;
      assert.throws(
        () =>
          verifyBrokerDeploymentProvenance({
            packageManifest,
            packageManifestBytes,
            installationReceipt: invalidTimestamp,
          }),
        /deployment provenance is invalid/u,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("installed broker fails closed without its administrator receipt", () => {
  assert.throws(
    () => loadInstalledBrokerDeploymentProvenance({}),
    /BROKER_PACKAGE_MANIFEST_PATH is required/u,
  );
});

test("mTLS deployment endpoint is additive and does not accept other identities", async () => {
  const deploymentProvenance = {
    recordType: "lab-service-deployment-provenance",
    service: "broker",
  };
  const handler = createBrokerRequestHandler({
    broker: {},
    deploymentProvenance,
    auditLog: () => {},
  });
  const accepted = fakeResponse();
  await handler(
    request({
      method: "GET",
      url: "/v1/deployment",
      identity: "controller:FW-LNX-NV-01",
    }),
    accepted,
  );
  assert.equal(accepted.statusCode, 200);
  assert.deepEqual(JSON.parse(accepted.body), deploymentProvenance);

  const rejected = fakeResponse();
  await handler(
    request({
      method: "GET",
      url: "/v1/deployment",
      identity: "observer:forge3d-trust",
    }),
    rejected,
  );
  assert.equal(rejected.statusCode, 400);
});

function brokerReceipt(manifest, manifestBytes) {
  return {
    schemaVersion: 1,
    recordType: "lab-service-deployment-provenance",
    service: "broker",
    serviceIdentity: "broker:forge3d-browser-lab",
    packageRun: {
      id: 101,
      attempt: 2,
      artifact: {
        id: 201,
        name: `browser-lab-broker-${manifest.targetSha}-101-2`,
        digest: `sha256:${"9".repeat(64)}`,
      },
    },
    source: {
      repository: manifest.repository,
      targetSha: manifest.targetSha,
      workflowSha: manifest.workflowSha,
    },
    packageManifest: {
      sha256: sha256(manifestBytes),
      attestation: {
        verified: true,
        repository: manifest.repository,
        signerWorkflow:
          "milos-agathon/forge3d-web/.github/workflows/browser-lab-broker.yml",
        sourceRef: "refs/heads/main",
        sourceDigest: manifest.targetSha,
        denySelfHostedRunners: true,
      },
    },
    archive: manifest.archive,
    configuration: { sha256: manifest.configurationSha256 },
    protocols: {
      broker: manifest.brokerProtocolVersion,
      cleanup: manifest.cleanupProtocolVersion,
    },
    administratorVerification: {
      status: "verified",
      method: "github-attestation",
      verifiedAt: "2026-07-31T10:00:00.000Z",
      verifiedBy: "lab-admin",
    },
  };
}

function readSchema(name) {
  return JSON.parse(
    readFileSync(
      new URL(`../schemas/${name}`, import.meta.url),
      "utf8",
    ),
  );
}

function request({ method, url, identity }) {
  return {
    method,
    url,
    socket: {
      authorized: true,
      getPeerCertificate: () => ({ subject: { CN: identity } }),
    },
  };
}

function fakeResponse() {
  return {
    statusCode: null,
    body: "",
    setHeader() {},
    writeHead(statusCode) {
      this.statusCode = statusCode;
    },
    end(value) {
      this.body += value ?? "";
    },
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
