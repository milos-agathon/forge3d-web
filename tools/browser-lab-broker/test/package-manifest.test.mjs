import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createBrokerPackageManifest } from "../scripts/create-package-manifest.mjs";

test("binds broker archive, exact source, configuration, and protocols", () => {
  const directory = mkdtempSync(join(tmpdir(), "forge3d-broker-package-"));
  try {
    const archive = join(directory, "browser-lab-broker.tar.gz");
    writeFileSync(archive, "archive fixture");
    const repositoryRoot = resolve(
      fileURLToPath(new URL("../../..", import.meta.url)),
    );
    const manifest = createBrokerPackageManifest({
      repositoryRoot,
      archivePath: archive,
      targetSha: "a".repeat(40),
      workflowSha: "b".repeat(40),
    });
    assert.equal(manifest.repository, "milos-agathon/forge3d-web");
    assert.equal(manifest.brokerProtocolVersion, "forge3d-browser-lab-broker/v1");
    assert.equal(
      manifest.cleanupProtocolVersion,
      "forge3d-browser-lab-cleanup/v1",
    );
    assert.match(manifest.archive.sha256, /^[0-9a-f]{64}$/u);
    assert.match(manifest.configurationSha256, /^[0-9a-f]{64}$/u);
    assert.equal(manifest.configuration.length, 10);
    assert.equal(manifest.package, "@forge3d/browser-lab-broker");
    assert.equal(manifest.version, "1.0.0");
    assert.equal(manifest.protocols.controller, "forge3d-browser-lab-controller/v1");
    assert.ok(
      manifest.files.some((file) => file.path === "src/server.mjs"),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
