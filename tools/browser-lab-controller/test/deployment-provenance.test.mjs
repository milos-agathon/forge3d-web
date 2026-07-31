import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  verify,
} from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assertJsonSchema } from "../../../crates/forge3d-web/tests/browser/json-schema-validator.mjs";
import { createControllerPackageManifest } from "../scripts/create-package-manifest.mjs";
import { canonicalJson } from "../src/controller-signing.mjs";
import {
  createSignedDeploymentProvenanceReceipt,
  loadControllerDeploymentProvenance,
  observeAndSignDeploymentProvenance,
  verifyControllerDeploymentProvenance,
} from "../src/deployment-provenance.mjs";
import { createInstalledControllerService } from "../src/controller-service.mjs";

const hostId = "FW-LNX-NV-01";
const targetSha = "a".repeat(40);
const workflowSha = "b".repeat(40);

test("strict schemas and runtime bind controller package and administrator receipt", () => {
  const fixture = createControllerFixture();
  try {
    const {
      installationReceipt,
      manifestPath,
      packageManifest,
      packageManifestBytes,
      packageRoot,
      receiptPath,
    } = fixture;
    assertJsonSchema(
      packageManifest,
      readSchema("controller-package-manifest.schema.json"),
    );
    assert.deepEqual(Object.keys(packageManifest), [
      "schemaVersion",
      "package",
      "version",
      "targetSha",
      "workflowSha",
      "archive",
      "archiveSha256",
      "files",
    ]);
    assertJsonSchema(
      installationReceipt,
      readSchema("lab-service-deployment-provenance.schema.json"),
    );
    assert.deepEqual(
      verifyControllerDeploymentProvenance({
        packageManifest,
        packageManifestBytes,
        installationReceipt,
        hostId,
      }),
      installationReceipt,
    );
    const leapDateWithoutMilliseconds = structuredClone(installationReceipt);
    leapDateWithoutMilliseconds.administratorVerification.verifiedAt =
      "2024-02-29T23:59:59Z";
    assert.deepEqual(
      verifyControllerDeploymentProvenance({
        packageManifest,
        packageManifestBytes,
        installationReceipt: leapDateWithoutMilliseconds,
        hostId,
      }),
      leapDateWithoutMilliseconds,
    );
    assert.deepEqual(
      loadControllerDeploymentProvenance({
        packageManifestPath: manifestPath,
        installationReceiptPath: receiptPath,
        packageRoot,
        hostId,
      }),
      installationReceipt,
    );

    const extraProperty = structuredClone(installationReceipt);
    extraProperty.unchecked = true;
    assert.throws(
      () =>
        verifyControllerDeploymentProvenance({
          packageManifest,
          packageManifestBytes,
          installationReceipt: extraProperty,
          hostId,
        }),
      /shape is invalid/u,
    );
    const changedDigest = structuredClone(installationReceipt);
    changedDigest.packageManifest.sha256 = "c".repeat(64);
    assert.throws(
      () =>
        verifyControllerDeploymentProvenance({
          packageManifest,
          packageManifestBytes,
          installationReceipt: changedDigest,
          hostId,
        }),
      /does not bind/u,
    );
    const wrongAttempt = structuredClone(installationReceipt);
    wrongAttempt.packageRun.attempt += 1;
    assert.throws(
      () =>
        verifyControllerDeploymentProvenance({
          packageManifest,
          packageManifestBytes,
          installationReceipt: wrongAttempt,
          hostId,
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
          verifyControllerDeploymentProvenance({
            packageManifest,
            packageManifestBytes,
            installationReceipt: invalidTimestamp,
            hostId,
          }),
        /deployment provenance is invalid/u,
      );
    }
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("installed controller fails closed before constructing runtime dependencies", () => {
  assert.throws(
    () =>
      createInstalledControllerService({
        environment: { FORGE3D_CONTROLLER_ASSET_ID: hostId },
      }),
    /FORGE3D_CONTROLLER_PACKAGE_MANIFEST_FILE is required/u,
  );
});

test("controller observes broker deployment and signs a separate provenance receipt", async () => {
  const fixture = createControllerFixture();
  try {
    const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const brokerDeployment = brokerReceipt();
    const signingKeyId = "controller-fw-lnx-nv-01-p256-v1";
    const observedAt = new Date("2026-07-31T10:05:00.000Z");
    const signed = await observeAndSignDeploymentProvenance({
      brokerClient: {
        async deployment() {
          return brokerDeployment;
        },
      },
      controllerDeployment: fixture.installationReceipt,
      run: { id: 301, attempt: 2 },
      hostId,
      trustedSha: targetSha,
      privateKey: keys.privateKey,
      signingKeyId,
      observedAt,
    });

    assert.deepEqual(signed.record.broker, brokerDeployment);
    assert.deepEqual(
      signed.record.controller,
      fixture.installationReceipt,
    );
    assert.equal(
      signed.record.recordType,
      "lab-service-deployment-provenance-receipt",
    );
    assert.equal(signed.record.runId, 301);
    assert.equal(signed.record.runAttempt, 2);
    assert.equal(signed.record.trustedSha, targetSha);
    assert.equal(signed.record.observedAt, observedAt.toISOString());
    assertJsonSchema(signed.record, deploymentReceiptSchema());
    assert.equal(
      verify(
        "SHA256",
        Buffer.from(signed.canonical),
        {
          key: keys.publicKey,
          dsaEncoding: "ieee-p1363",
        },
        Buffer.from(signed.signature.value, "base64url"),
      ),
      true,
    );

    const mismatched = structuredClone(brokerDeployment);
    mismatched.source.workflowSha = "d".repeat(40);
    assert.throws(
      () =>
        createSignedDeploymentProvenanceReceipt({
          run: { id: 301, attempt: 2 },
          hostId,
          trustedSha: targetSha,
          brokerDeployment: mismatched,
          controllerDeployment: fixture.installationReceipt,
          privateKey: keys.privateKey,
          signingKeyId,
          observedAt,
        }),
      /provenance disagree/u,
    );

    const forgedAttestation = structuredClone(brokerDeployment);
    forgedAttestation.packageManifest.attestation.sourceDigest =
      "d".repeat(40);
    assert.throws(
      () =>
        createSignedDeploymentProvenanceReceipt({
          run: { id: 301, attempt: 2 },
          hostId,
          trustedSha: targetSha,
          brokerDeployment: forgedAttestation,
          controllerDeployment: fixture.installationReceipt,
          privateKey: keys.privateKey,
          signingKeyId,
          observedAt,
        }),
      /deployment provenance is invalid/u,
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("broker and controller installation provenance schemas stay identical", () => {
  const brokerSchema = JSON.parse(
    readFileSync(
      new URL(
        "../../browser-lab-broker/schemas/lab-service-deployment-provenance.schema.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.deepEqual(
    readSchema("lab-service-deployment-provenance.schema.json"),
    brokerSchema,
  );
});

function createControllerFixture() {
  const directory = mkdtempSync(
    join(tmpdir(), "forge3d-controller-deployment-"),
  );
  const packageRoot = join(directory, "package");
  mkdirSync(packageRoot);
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@forge3d/browser-lab-controller",
      version: "1.0.0",
    }),
  );
  mkdirSync(join(packageRoot, "src"));
  writeFileSync(
    join(packageRoot, "src", "bootstrap.mjs"),
    "export const bootstrap = true;\n",
  );
  writeFileSync(
    join(packageRoot, "src", "controller-service.mjs"),
    "export const service = true;\n",
  );
  const archivePath = join(directory, "browser-lab-controller.tar.gz");
  writeFileSync(archivePath, "controller archive");
  const packageManifest = createControllerPackageManifest({
    packageRoot,
    archivePath,
    targetSha,
    workflowSha,
  });
  const packageManifestBytes = Buffer.from(JSON.stringify(packageManifest));
  const installationReceipt = controllerReceipt(
    packageManifest,
    packageManifestBytes,
  );
  const manifestPath = join(directory, "controller-package-manifest.json");
  const receiptPath = join(
    directory,
    "controller-installation-receipt.json",
  );
  writeFileSync(manifestPath, packageManifestBytes);
  writeFileSync(receiptPath, JSON.stringify(installationReceipt));
  return {
    directory,
    installationReceipt,
    manifestPath,
    packageManifest,
    packageManifestBytes,
    packageRoot,
    receiptPath,
  };
}

function controllerReceipt(manifest, manifestBytes) {
  return serviceReceipt({
    service: "controller",
    serviceIdentity: `controller:${hostId}`,
    signerWorkflow:
      "milos-agathon/forge3d-web/.github/workflows/browser-lab-controller.yml",
    source: {
      repository: "milos-agathon/forge3d-web",
      targetSha: manifest.targetSha,
      workflowSha: manifest.workflowSha,
    },
    packageManifestSha256: sha256(manifestBytes),
    archive: {
      name: manifest.archive,
      sha256: manifest.archiveSha256,
    },
    configurationSha256: sha256(
      Buffer.from(canonicalJson(manifest.files)),
    ),
    packageRun: { id: 102, attempt: 2 },
  });
}

function brokerReceipt() {
  return serviceReceipt({
    service: "broker",
    serviceIdentity: "broker:forge3d-browser-lab",
    signerWorkflow:
      "milos-agathon/forge3d-web/.github/workflows/browser-lab-broker.yml",
    source: {
      repository: "milos-agathon/forge3d-web",
      targetSha,
      workflowSha,
    },
    packageManifestSha256: "c".repeat(64),
    archive: {
      name: "browser-lab-broker.tar.gz",
      sha256: "d".repeat(64),
    },
    configurationSha256: "e".repeat(64),
    packageRun: { id: 101, attempt: 2 },
  });
}

function serviceReceipt({
  service,
  serviceIdentity,
  signerWorkflow,
  source,
  packageManifestSha256,
  archive,
  configurationSha256,
  packageRun,
}) {
  return {
    schemaVersion: 1,
    recordType: "lab-service-deployment-provenance",
    service,
    serviceIdentity,
    packageRun: {
      id: packageRun.id,
      attempt: packageRun.attempt,
      artifact: {
        id: service === "broker" ? 201 : 202,
        name:
          `browser-lab-${service}-${source.targetSha}-${packageRun.id}-${packageRun.attempt}`,
        digest: `sha256:${"9".repeat(64)}`,
      },
    },
    source,
    packageManifest: {
      sha256: packageManifestSha256,
      attestation: {
        verified: true,
        repository: source.repository,
        signerWorkflow,
        sourceRef: "refs/heads/main",
        sourceDigest: source.targetSha,
        denySelfHostedRunners: true,
      },
    },
    archive,
    configuration: { sha256: configurationSha256 },
    protocols: {
      broker: "forge3d-browser-lab-broker/v1",
      cleanup: "forge3d-browser-lab-cleanup/v1",
    },
    administratorVerification: {
      status: "verified",
      method: "github-attestation",
      verifiedAt: "2026-07-31T10:00:00.000Z",
      verifiedBy: "lab-admin",
    },
  };
}

function deploymentReceiptSchema() {
  const schema = readSchema(
    "controller-deployment-provenance-receipt.schema.json",
  );
  const serviceSchema = readSchema(
    "lab-service-deployment-provenance.schema.json",
  );
  schema.$defs = {
    deployment: serviceSchema.$defs.record,
    sha40: serviceSchema.$defs.sha40,
    sha256: serviceSchema.$defs.sha256,
  };
  schema.properties.broker = { $ref: "#/$defs/deployment" };
  schema.properties.controller = { $ref: "#/$defs/deployment" };
  return schema;
}

function readSchema(name) {
  return JSON.parse(
    readFileSync(new URL(`../schemas/${name}`, import.meta.url), "utf8"),
  );
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
