import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  linkSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createControllerPackageManifest } from "../scripts/create-package-manifest.mjs";
import {
  startControllerBootstrap,
  verifyControllerBootstrap,
} from "../src/bootstrap.mjs";
import { canonicalJson } from "../src/controller-signing.mjs";

const targetSha = "a".repeat(40);
const workflowSha = "b".repeat(40);

test("controller bootstrap verifies the exact installed tree before runtime import", async () => {
  const fixture = createFixture();
  try {
    assert.doesNotThrow(() => verifyControllerBootstrap(fixture.input));
    const leapDateWithoutMilliseconds = structuredClone(fixture.receipt);
    leapDateWithoutMilliseconds.administratorVerification.verifiedAt =
      "2024-02-29T23:59:59Z";
    writeFileSync(
      fixture.receiptPath,
      JSON.stringify(leapDateWithoutMilliseconds),
    );
    assert.doesNotThrow(() => verifyControllerBootstrap(fixture.input));

    writeFileSync(
      join(fixture.packageRoot, "src", "controller-service.mjs"),
      "export const tampered = true;\n",
    );
    let imported = false;
    await assert.rejects(
      () =>
        startControllerBootstrap({
          argv: ["node", "bootstrap.mjs"],
          baseEnvironment: fixture.environment,
          executedPackageRoot: fixture.packageRoot,
          loadRuntime: async () => {
            imported = true;
            return {};
          },
        }),
      /file digest does not match/u,
    );
    assert.equal(imported, false);
  } finally {
    fixture.cleanup();
  }
});

test("controller bootstrap rejects missing, extra, symlinked, and wrong-root trees", () => {
  for (const mutate of [
    (fixture) =>
      rmSync(join(fixture.packageRoot, "src", "controller-service.mjs")),
    (fixture) =>
      writeFileSync(join(fixture.packageRoot, "unexpected.mjs"), "unexpected\n"),
    (fixture) =>
      symlinkSync(
        join(fixture.packageRoot, "package.json"),
        join(fixture.packageRoot, "linked-package.json"),
      ),
    (fixture) =>
      linkSync(
        join(fixture.packageRoot, "package.json"),
        join(fixture.directory, "hard-linked-package.json"),
      ),
  ]) {
    const fixture = createFixture();
    try {
      mutate(fixture);
      assert.throws(
        () => verifyControllerBootstrap(fixture.input),
        /file set does not match|symlink|hard-linked/u,
      );
    } finally {
      fixture.cleanup();
    }
  }

  const fixture = createFixture();
  try {
    assert.throws(
      () =>
        verifyControllerBootstrap({
          ...fixture.input,
          executedPackageRoot: fixture.directory,
        }),
      /not the executed package root/u,
    );
  } finally {
    fixture.cleanup();
  }
});

test("controller bootstrap rejects receipt substitution before runtime import", async () => {
  for (const mutate of [
    (receipt) => {
      receipt.source.workflowSha = "c".repeat(40);
    },
    (receipt) => {
      receipt.administratorVerification.verifiedAt = "0";
    },
    (receipt) => {
      receipt.administratorVerification.verifiedAt =
        "2026-02-30T10:00:00.000Z";
    },
    (receipt) => {
      receipt.administratorVerification.verifiedAt =
        "2026-01-01T24:00:00.000Z";
    },
    (receipt) => {
      receipt.administratorVerification.verifiedAt =
        "2025-02-29T10:00:00.000Z";
    },
  ]) {
    const fixture = createFixture();
    try {
      const changed = structuredClone(fixture.receipt);
      mutate(changed);
      writeFileSync(fixture.receiptPath, JSON.stringify(changed));
      let imported = false;
      await assert.rejects(
        () =>
          startControllerBootstrap({
            argv: ["node", "bootstrap.mjs"],
            baseEnvironment: fixture.environment,
            executedPackageRoot: fixture.packageRoot,
            loadRuntime: async () => {
              imported = true;
              return {};
            },
          }),
        /administrator receipt is invalid/u,
      );
      assert.equal(imported, false);
    } finally {
      fixture.cleanup();
    }
  }
});

test("controller bootstrap binds its receipt to the configured asset before runtime import", async () => {
  for (const environmentMutation of [
    (environment) => {
      delete environment.FORGE3D_CONTROLLER_ASSET_ID;
    },
    (environment) => {
      environment.FORGE3D_CONTROLLER_ASSET_ID = "FW-LNX-NV-02";
    },
  ]) {
    const fixture = createFixture();
    try {
      const environment = { ...fixture.environment };
      environmentMutation(environment);
      let imported = false;
      await assert.rejects(
        () =>
          startControllerBootstrap({
            argv: ["node", "bootstrap.mjs"],
            baseEnvironment: environment,
            executedPackageRoot: fixture.packageRoot,
            loadRuntime: async () => {
              imported = true;
              return {};
            },
          }),
        /FORGE3D_CONTROLLER_ASSET_ID is required|administrator receipt is invalid/u,
      );
      assert.equal(imported, false);
    } finally {
      fixture.cleanup();
    }
  }
});

function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), "forge3d-controller-bootstrap-"));
  const packageRoot = join(directory, "package");
  mkdirSync(join(packageRoot, "src"), { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@forge3d/browser-lab-controller",
      version: "1.0.0",
    }),
  );
  writeFileSync(
    join(packageRoot, "src", "bootstrap.mjs"),
    "export const bootstrap = true;\n",
  );
  writeFileSync(
    join(packageRoot, "src", "controller-service.mjs"),
    "export const service = true;\n",
  );
  const archivePath = join(directory, "browser-lab-controller-1.0.0.tar.gz");
  writeFileSync(archivePath, "controller archive");
  const manifest = createControllerPackageManifest({
    packageRoot,
    archivePath,
    targetSha,
    workflowSha,
  });
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const manifestPath = join(directory, "controller-package-manifest.json");
  const receiptPath = join(directory, "controller-installation-receipt.json");
  const receipt = {
    schemaVersion: 1,
    recordType: "lab-service-deployment-provenance",
    service: "controller",
    serviceIdentity: "controller:FW-LNX-NV-01",
    packageRun: {
      id: 102,
      attempt: 2,
      artifact: {
        id: 202,
        name: `browser-lab-controller-${targetSha}-102-2`,
        digest: `sha256:${"9".repeat(64)}`,
      },
    },
    source: {
      repository: "milos-agathon/forge3d-web",
      targetSha,
      workflowSha,
    },
    packageManifest: {
      sha256: sha256(manifestBytes),
      attestation: {
        verified: true,
        repository: "milos-agathon/forge3d-web",
        signerWorkflow:
          "milos-agathon/forge3d-web/.github/workflows/browser-lab-controller.yml",
        sourceRef: "refs/heads/main",
        sourceDigest: targetSha,
        denySelfHostedRunners: true,
      },
    },
    archive: {
      name: manifest.archive,
      sha256: manifest.archiveSha256,
    },
    configuration: {
      sha256: sha256(Buffer.from(canonicalJson(manifest.files))),
    },
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
  writeFileSync(manifestPath, manifestBytes);
  writeFileSync(receiptPath, JSON.stringify(receipt));
  const environment = {
    FORGE3D_CONTROLLER_ASSET_ID: "FW-LNX-NV-01",
    FORGE3D_CONTROLLER_PACKAGE_MANIFEST_FILE: manifestPath,
    FORGE3D_CONTROLLER_INSTALLATION_RECEIPT_FILE: receiptPath,
    FORGE3D_CONTROLLER_PACKAGE_ROOT: packageRoot,
  };
  return {
    directory,
    environment,
    input: {
      packageManifestPath: manifestPath,
      installationReceiptPath: receiptPath,
      packageRoot,
      controllerAssetId: "FW-LNX-NV-01",
      executedPackageRoot: packageRoot,
    },
    manifest,
    packageRoot,
    receipt,
    receiptPath,
    cleanup() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
