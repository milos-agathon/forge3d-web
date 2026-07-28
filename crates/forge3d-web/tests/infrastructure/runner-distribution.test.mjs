import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { sha256Hex } from "../../scripts/canonical-json.mjs";
import { createRunnerDistributionManifest } from "../../scripts/generate-runner-distribution-manifest.mjs";
import {
  verifyRunnerPolicy,
  verifyRunnerTree,
} from "../../scripts/verify-runner-distribution.mjs";

test("locks immutable files, modes, symlinks, and narrow transient paths", () => {
  const root = mkdtempSync(join(tmpdir(), "forge3d-runner-fixture-"));
  try {
    mkdirSync(join(root, "bin"));
    writeFileSync(join(root, "bin", "Runner.Listener"), "immutable");
    chmodSync(join(root, "bin", "Runner.Listener"), 0o755);
    symlinkSync("bin/Runner.Listener", join(root, "run"));
    const manifest = createRunnerDistributionManifest({
      runnerVersion: "2.336.0",
      generatedAt: "2026-07-28T12:00:00.000Z",
      distributions: [
        {
          platform: "linux-x64",
          archiveFileName: "runner.tar.gz",
          archiveSha256: "a".repeat(64),
          root,
        },
      ],
    });
    const transientPolicy = makeTransientPolicy();
    assert.equal(
      verifyRunnerTree({ root, platform: "linux-x64", manifest, transientPolicy }).ok,
      true,
    );

    mkdirSync(join(root, "_diag"));
    writeFileSync(join(root, "_diag", "Runner_1.log"), "retained");
    const withDiagnostics = verifyRunnerTree({
      root,
      platform: "linux-x64",
      manifest,
      transientPolicy,
    });
    assert.deepEqual(withDiagnostics.transientEntries, [
      "_diag",
      "_diag/Runner_1.log",
    ]);

    writeFileSync(join(root, "unknown"), "bad");
    assert.throws(
      () => verifyRunnerTree({ root, platform: "linux-x64", manifest, transientPolicy }),
      /unknown runner path/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detects modified immutable distribution content and mode", () => {
  const root = mkdtempSync(join(tmpdir(), "forge3d-runner-fixture-"));
  try {
    writeFileSync(join(root, "Runner.Listener"), "immutable");
    chmodSync(join(root, "Runner.Listener"), 0o755);
    const manifest = createRunnerDistributionManifest({
      runnerVersion: "2.336.0",
      generatedAt: "2026-07-28T12:00:00.000Z",
      distributions: [
        {
          platform: "linux-x64",
          archiveFileName: "runner.tar.gz",
          archiveSha256: "a".repeat(64),
          root,
        },
      ],
    });
    writeFileSync(join(root, "Runner.Listener"), "modified");
    assert.throws(
      () =>
        verifyRunnerTree({
          root,
          platform: "linux-x64",
          manifest,
          transientPolicy: makeTransientPolicy(),
        }),
      /entry changed/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("binds browser policy to manifest, archive, and transient digests", () => {
  const manifest = {
    schemaVersion: 1,
    runnerVersion: "2.336.0",
    generatedAt: "2026-07-28T12:00:00.000Z",
    distributions: [
      {
        platform: "linux-x64",
        archiveFileName: "runner.tar.gz",
        archiveSha256: "a".repeat(64),
        entries: [{}],
      },
    ],
  };
  const transientPolicy = makeTransientPolicy();
  const browserPolicy = {
    schemaVersion: 1,
    provisioningState: "pending-jit-canary",
    runnerVersion: "2.336.0",
    repositoryJitRunnerGroupId: 1,
    jitWorkFolder: "_work",
    brokerProtocolVersion: "forge3d-browser-lab-broker/v1",
    cleanupProtocolVersion: "forge3d-browser-lab-cleanup/v1",
    archives: [
      {
        platform: "linux-x64",
        fileName: "runner.tar.gz",
        sha256: "a".repeat(64),
      },
    ],
    runnerDistributionManifestSha256: sha256Hex(manifest),
    runnerTransientPathPolicySha256: sha256Hex(transientPolicy),
  };
  assert.equal(
    verifyRunnerPolicy({ browserPolicy, manifest, transientPolicy }).ok,
    true,
  );
  assert.throws(
    () =>
      verifyRunnerPolicy({
        browserPolicy,
        manifest,
        transientPolicy,
        requireCanary: true,
      }),
    /not passed the clean JIT canary/u,
  );
  const changed = structuredClone(browserPolicy);
  changed.archives[0].sha256 = "b".repeat(64);
  assert.throws(
    () => verifyRunnerPolicy({ browserPolicy: changed, manifest, transientPolicy }),
    /archive pin disagrees/u,
  );
});

function makeTransientPolicy() {
  return {
    schemaVersion: 1,
    runnerVersion: "2.336.0",
    canaryState: "pending",
    paths: [
      {
        pattern: "_diag/**",
        kind: "tree",
        purpose: "diagnostics",
        evidence: "fixture",
      },
      {
        pattern: "_work/**",
        kind: "tree",
        purpose: "work",
        evidence: "fixture",
      },
    ],
  };
}
