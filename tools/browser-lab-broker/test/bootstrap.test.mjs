import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { createBrokerPackageManifest } from "../scripts/create-package-manifest.mjs";
import {
  startBrokerBootstrap,
  verifyBrokerBootstrap,
} from "../src/bootstrap.mjs";
import { canonicalJson } from "../src/canonical-json.mjs";
import { loadBrokerDeploymentProvenance } from "../src/deployment-provenance.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const targetSha = "a".repeat(40);
const workflowSha = "b".repeat(40);
const configurationPaths = [
  "crates/forge3d-web/tests/infrastructure/browser-policy.json",
  "crates/forge3d-web/tests/infrastructure/broker-lifecycle.schema.json",
  "crates/forge3d-web/tests/infrastructure/broker-protocol.schema.json",
  "crates/forge3d-web/tests/infrastructure/controller-health-endpoints.json",
  "crates/forge3d-web/tests/infrastructure/hardware-matrix.json",
  "crates/forge3d-web/tests/infrastructure/repository-trust-policy.json",
  "crates/forge3d-web/tests/infrastructure/runner-distribution-manifest.json",
  "crates/forge3d-web/tests/infrastructure/runner-transient-path-policy.json",
  "crates/forge3d-web/tests/infrastructure/workflow-actions-lock.json",
];

test("broker bootstrap verifies retained archive, runtime, and configuration before import", async () => {
  const fixture = createFixture();
  try {
    assert.doesNotThrow(() => verifyBrokerBootstrap(fixture.input));
    const leapDateWithoutMilliseconds = structuredClone(fixture.receipt);
    leapDateWithoutMilliseconds.administratorVerification.verifiedAt =
      "2024-02-29T23:59:59Z";
    writeFileSync(
      fixture.receiptPath,
      JSON.stringify(leapDateWithoutMilliseconds),
    );
    assert.doesNotThrow(() => verifyBrokerBootstrap(fixture.input));
    assert.equal(
      loadBrokerDeploymentProvenance({
        packageManifestPath: fixture.manifestPath,
        installationReceiptPath: fixture.receiptPath,
        packageArchivePath: fixture.archivePath,
        packageRoot: fixture.packageRoot,
        configurationRoot: fixture.configurationRoot,
      }).packageManifest.sha256,
      fixture.receipt.packageManifest.sha256,
    );

    writeFileSync(
      join(fixture.packageRoot, "src", "server.mjs"),
      "export const tampered = true;\n",
    );
    let imported = false;
    await assert.rejects(
      () =>
        startBrokerBootstrap(fixture.environment, {
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

test("broker bootstrap rejects missing, extra, symlinked, and wrong-root trees", () => {
  for (const mutate of [
    (fixture) => rmSync(join(fixture.packageRoot, "src", "server.mjs")),
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
    (fixture) =>
      writeFileSync(
        join(fixture.configurationRoot, "hardware-matrix.json"),
        "tampered\n",
      ),
  ]) {
    const fixture = createFixture();
    try {
      mutate(fixture);
      assert.throws(
        () => verifyBrokerBootstrap(fixture.input),
        /file set does not match|file digest does not match|symlink|hard-linked/u,
      );
    } finally {
      fixture.cleanup();
    }
  }

  const fixture = createFixture();
  try {
    assert.throws(
      () =>
        verifyBrokerBootstrap({
          ...fixture.input,
          executedPackageRoot: fixture.directory,
        }),
      /not the executed package root/u,
    );
  } finally {
    fixture.cleanup();
  }
});

test("broker bootstrap rejects archive substitution and non-closed tar layouts", () => {
  for (const options of [
    { extraOuter: true },
    { extraInner: true },
    { duplicateOuter: true },
    { traversalInner: true },
    { linkedInner: true },
  ]) {
    const fixture = createFixture(options);
    try {
      assert.throws(
        () => verifyBrokerBootstrap(fixture.input),
        /archive layout is invalid|package identity is invalid|invalid tar member/u,
      );
    } finally {
      fixture.cleanup();
    }
  }

  const fixture = createFixture();
  try {
    writeFileSync(fixture.archivePath, "changed archive");
    assert.throws(
      () => verifyBrokerBootstrap(fixture.input),
      /retained package archive does not match/u,
    );
  } finally {
    fixture.cleanup();
  }
});

test("broker bootstrap rejects receipt substitution before runtime import", async () => {
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
          startBrokerBootstrap(fixture.environment, {
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

test("broker service uses fixed bootstrap, archive, package, and configuration roots", () => {
  const service = readFileSync(
    new URL("../services/browser-lab-broker.service", import.meta.url),
    "utf8",
  );
  const environment = readFileSync(
    new URL("../services/browser-lab-broker.env.example", import.meta.url),
    "utf8",
  );
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  const bootstrap = readFileSync(
    new URL("../src/bootstrap.mjs", import.meta.url),
    "utf8",
  );
  const runtimeProvenance = readFileSync(
    new URL("../src/deployment-provenance.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    service,
    /ExecStart=\/usr\/bin\/node \/opt\/forge3d\/browser-lab-broker\/src\/bootstrap\.mjs/u,
  );
  for (const binding of [
    "BROKER_PACKAGE_ROOT=/opt/forge3d/browser-lab-broker",
    "BROKER_PACKAGE_ARCHIVE_PATH=/opt/forge3d/browser-lab-broker-package/browser-lab-broker.tar.gz",
    "BROKER_CONFIGURATION_ROOT=/etc/forge3d/browser-lab-broker-config",
  ]) {
    assert.equal(service.includes(binding), true);
    assert.equal(environment.includes(binding), true);
  }
  assert.equal(packageJson.scripts.start, "node src/bootstrap.mjs");
  assert.equal(
    [...bootstrap.matchAll(/from\s+["']([^"']+)["']/gu)].every(
      (match) => match[1].startsWith("node:"),
    ),
    true,
  );
  assert.ok(
    bootstrap.indexOf("verifyBrokerBootstrap") <
      bootstrap.indexOf('import("./server.mjs")'),
  );
  assert.equal(runtimeProvenance.includes('from "./bootstrap.mjs"'), false);
});

function createFixture({
  duplicateOuter = false,
  extraOuter = false,
  extraInner = false,
  linkedInner = false,
  traversalInner = false,
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "forge3d-broker-bootstrap-"));
  const packageRoot = join(directory, "package");
  const configurationRoot = join(directory, "config");
  mkdirSync(packageRoot);
  mkdirSync(configurationRoot);
  const packageFiles = new Map([
    [
      "package.json",
      Buffer.from(
        JSON.stringify({
          name: "@forge3d/browser-lab-broker",
          version: "1.0.0",
        }),
      ),
    ],
    ["README.md", Buffer.from("broker package\n")],
    [
      "schemas/broker-package-manifest.schema.json",
      Buffer.from("{}\n"),
    ],
    [
      "schemas/lab-service-deployment-provenance.schema.json",
      Buffer.from("{}\n"),
    ],
    [
      "services/browser-lab-broker.env.example",
      Buffer.from("BROKER_HOST=127.0.0.1\n"),
    ],
    [
      "services/browser-lab-broker.service",
      Buffer.from("[Service]\n"),
    ],
    ["src/bootstrap.mjs", Buffer.from("export const bootstrap = true;\n")],
    ["src/server.mjs", Buffer.from("export const server = true;\n")],
  ]);
  for (const [path, bytes] of packageFiles) {
    const destination = join(packageRoot, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes);
  }
  const nestedFiles = new Map(
    [...packageFiles].map(([path, bytes]) => [`package/${path}`, bytes]),
  );
  if (extraInner) {
    nestedFiles.set("package/test/unexpected.mjs", Buffer.from("unexpected\n"));
  }
  if (traversalInner) {
    nestedFiles.set("package/../escape.mjs", Buffer.from("escape\n"));
  }
  const npmArchive = tarGzip(nestedFiles, {
    memberTypes: linkedInner
      ? new Map([["package/src/server.mjs", "2"]])
      : new Map(),
  });
  const outerFiles = new Map([
    [
      "broker-package/package/forge3d-browser-lab-broker-1.0.0.tgz",
      npmArchive,
    ],
  ]);
  for (const path of configurationPaths) {
    const bytes = readFileSync(resolve(repositoryRoot, path));
    outerFiles.set(`broker-package/config/${path.split("/").at(-1)}`, bytes);
    writeFileSync(join(configurationRoot, path.split("/").at(-1)), bytes);
  }
  if (extraOuter) {
    outerFiles.set("broker-package/unexpected.txt", Buffer.from("unexpected\n"));
  }
  const outerEntries = [...outerFiles];
  if (duplicateOuter) {
    outerEntries.push([
      "broker-package/package/forge3d-browser-lab-broker-1.0.0.tgz",
      npmArchive,
    ]);
  }
  const archivePath = join(directory, "browser-lab-broker.tar.gz");
  writeFileSync(archivePath, tarGzip(outerEntries));
  const manifest = createBrokerPackageManifest({
    repositoryRoot,
    archivePath,
    targetSha,
    workflowSha,
  });
  const manifestBytes = Buffer.from(canonicalJson(manifest));
  const manifestPath = join(directory, "broker-package-manifest.json");
  const receiptPath = join(directory, "broker-installation-receipt.json");
  const receipt = {
    schemaVersion: 1,
    recordType: "lab-service-deployment-provenance",
    service: "broker",
    serviceIdentity: "broker:forge3d-browser-lab",
    packageRun: {
      id: 101,
      attempt: 2,
      artifact: {
        id: 201,
        name: `browser-lab-broker-${targetSha}-101-2`,
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
          "milos-agathon/forge3d-web/.github/workflows/browser-lab-broker.yml",
        sourceRef: "refs/heads/main",
        sourceDigest: targetSha,
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
  writeFileSync(manifestPath, manifestBytes);
  writeFileSync(receiptPath, JSON.stringify(receipt));
  const environment = {
    BROKER_PACKAGE_MANIFEST_PATH: manifestPath,
    BROKER_INSTALLATION_RECEIPT_PATH: receiptPath,
    BROKER_PACKAGE_ARCHIVE_PATH: archivePath,
    BROKER_PACKAGE_ROOT: packageRoot,
    BROKER_CONFIGURATION_ROOT: configurationRoot,
  };
  return {
    archivePath,
    configurationRoot,
    directory,
    environment,
    input: {
      packageManifestPath: manifestPath,
      installationReceiptPath: receiptPath,
      packageArchivePath: archivePath,
      packageRoot,
      configurationRoot,
      executedPackageRoot: packageRoot,
    },
    manifestPath,
    packageRoot,
    receipt,
    receiptPath,
    cleanup() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function tarGzip(files, { memberTypes = new Map() } = {}) {
  const parts = [];
  for (const [path, bytes] of files) {
    const header = Buffer.alloc(512);
    writeTarString(header, 0, 100, path);
    writeTarOctal(header, 100, 8, 0o644);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, bytes.length);
    writeTarOctal(header, 136, 12, 0);
    header.fill(32, 148, 156);
    header[156] = (memberTypes.get(path) ?? "0").charCodeAt(0);
    writeTarString(header, 257, 6, "ustar");
    writeTarString(header, 263, 2, "00");
    const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
    const checksumText = checksum.toString(8).padStart(6, "0");
    header.write(checksumText, 148, "ascii");
    header[154] = 0;
    header[155] = 32;
    parts.push(header, bytes);
    const padding = (512 - (bytes.length % 512)) % 512;
    if (padding > 0) parts.push(Buffer.alloc(padding));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts), { mtime: 0 });
}

function writeTarString(header, offset, length, value) {
  const bytes = Buffer.from(value);
  if (bytes.length > length) throw new Error(`tar test path is too long: ${value}`);
  bytes.copy(header, offset);
}

function writeTarOctal(header, offset, length, value) {
  const text = value.toString(8).padStart(length - 1, "0");
  header.write(text, offset, "ascii");
  header[offset + length - 1] = 0;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
