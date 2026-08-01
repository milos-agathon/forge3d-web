import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalJson } from "../src/controller-signing.mjs";
import { validateInstalledControllerEvidence } from "../src/installation-evidence.mjs";

test("reviewed helper digest rejects a substituted file and self-rewritten receipt", () => {
  const directory = mkdtempSync(join(tmpdir(), "forge3d-installation-"));
  try {
    const paths = {
      service: join(directory, "controller-service.mjs"),
      browserPolicy: join(directory, "browser-policy.json"),
      helperPolicy: join(directory, "helper-policy.json"),
      inventory: join(directory, "inventory-helper"),
    };
    writeFileSync(paths.service, "reviewed-service");
    writeFileSync(paths.browserPolicy, "reviewed-browser-policy");
    writeFileSync(paths.helperPolicy, "reviewed-helper-policy");
    writeFileSync(paths.inventory, "reviewed-inventory-helper");
    const files = installedFiles(paths);
    const configuration = files
      .filter((file) => file.role === "configuration")
      .map((file) => ({ path: file.packagePath, sha256: file.sha256 }));
    const manifest = {
      version: "1.0.0",
      targetSha: "a".repeat(40),
      workflowSha: "b".repeat(40),
      archive: {
        name: "browser-lab-controller-1.0.0.tar.gz",
        sha256: "c".repeat(64),
      },
      protocols: protocols(),
      configuration,
      configurationSha256: sha256(canonicalJson(configuration)),
      files: [
        {
          path: "src/controller-service.mjs",
          sha256: files.find((file) => file.role === "service").sha256,
        },
      ],
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    const receipt = installationReceipt({ files, manifest, manifestBytes, directory });
    const requiredHelpers = [
      {
        identity: "FORGE3D_BROWSER_INVENTORY_HELPER",
        path: paths.inventory,
        packagePath: null,
        version: null,
        sha256: sha256("reviewed-inventory-helper"),
      },
    ];
    const request = {
      receipt,
      manifest,
      manifestBytes,
      hostId: "FW-LNX-NV-01",
      inventoryHelperPath: paths.inventory,
      servicePath: paths.service,
      requiredHelpers,
      requiredConfigurations: [
        {
          packagePath: "crates/forge3d-web/tests/infrastructure/browser-policy.json",
          path: paths.browserPolicy,
        },
        {
          packagePath:
            "crates/forge3d-web/tests/infrastructure/controller-helper-digest-policy.json",
          path: paths.helperPolicy,
        },
      ],
    };
    assert.equal(validateInstalledControllerEvidence(request), receipt);

    writeFileSync(paths.inventory, "reviewed-inventory-helpeR");
    const helper = receipt.installed.files.find(
      (file) => file.identity === "FORGE3D_BROWSER_INVENTORY_HELPER",
    );
    helper.sha256 = sha256("reviewed-inventory-helpeR");
    receipt.installed.filesSha256 = sha256(canonicalJson(receipt.installed.files));
    assert.throws(
      () => validateInstalledControllerEvidence(request),
      /service\/helper paths are not pinned/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function installedFiles(paths) {
  return [
    installedFile(
      "configuration",
      "config:browser-policy",
      paths.browserPolicy,
      "crates/forge3d-web/tests/infrastructure/browser-policy.json",
    ),
    installedFile(
      "service",
      "service",
      paths.service,
      "src/controller-service.mjs",
    ),
    installedFile(
      "configuration",
      "config:helper-policy",
      paths.helperPolicy,
      "crates/forge3d-web/tests/infrastructure/controller-helper-digest-policy.json",
    ),
    installedFile(
      "helper",
      "FORGE3D_BROWSER_INVENTORY_HELPER",
      paths.inventory,
      null,
    ),
  ].sort((left, right) => left.path.localeCompare(right.path));
}

function installedFile(role, identity, path, packagePath) {
  return {
    role,
    identity,
    path,
    packagePath,
    version: null,
    sha256: sha256(
      role === "service"
        ? "reviewed-service"
        : identity === "config:browser-policy"
          ? "reviewed-browser-policy"
          : identity === "config:helper-policy"
            ? "reviewed-helper-policy"
            : "reviewed-inventory-helper",
    ),
  };
}

function installationReceipt({ files, manifest, manifestBytes, directory }) {
  return {
    schemaVersion: 1,
    recordType: "lab-service-installation",
    component: "controller",
    instanceId: "FW-LNX-NV-01",
    repository: "milos-agathon/forge3d-web",
    package: {
      name: "@forge3d/browser-lab-controller",
      version: manifest.version,
      targetSha: manifest.targetSha,
      workflowSha: manifest.workflowSha,
      archive: manifest.archive,
      manifestSha256: sha256(manifestBytes),
      configurationSha256: manifest.configurationSha256,
      protocols: protocols(),
    },
    attestation: {
      verified: true,
      repository: "milos-agathon/forge3d-web",
      signerWorkflow:
        "milos-agathon/forge3d-web/.github/workflows/browser-lab-controller.yml",
      sourceRef: "refs/heads/main",
      sourceDigest: manifest.targetSha,
      denySelfHostedRunners: true,
      archiveSha256: manifest.archive.sha256,
      manifestSha256: sha256(manifestBytes),
    },
    installed: {
      root: directory,
      files,
      filesSha256: sha256(canonicalJson(files)),
    },
    verifiedAt: "2026-07-31T10:00:00.000Z",
  };
}

function protocols() {
  return {
    controller: "forge3d-browser-lab-controller/v1",
    broker: "forge3d-browser-lab-broker/v1",
    cleanup: "forge3d-browser-lab-cleanup/v1",
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
