import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const workflow = readFileSync(
  resolve(
    import.meta.dirname,
    "../../../../.github/workflows/publish-browser-lab-canary.yml",
  ),
  "utf8",
);
const readinessWorkflow = readFileSync(
  resolve(
    import.meta.dirname,
    "../../../../.github/workflows/browser-lab-infrastructure-readiness.yml",
  ),
  "utf8",
);
const readinessSource = readFileSync(
  resolve(import.meta.dirname, "../../scripts/compute-lab-readiness.mjs"),
  "utf8",
);
const observer = block(
  "observe-lab-canary-publication-trust",
  "validate-lab-canary",
);
const preflight = block("validate-lab-canary", "publish-lab-canary");
const publisher = block("publish-lab-canary", "attest-postpublication-record");
const attester = block("attest-postpublication-record", null);
const publicationSchema = readFileSync(
  resolve(import.meta.dirname, "./lab-canary-publication-record.schema.json"),
);
const logicalPublisher = publisher.replace(/\\\n\s*/gu, " ");

test("canary accepts only fixed host/manual IDs and derives candidate and tag", () => {
  for (const input of [
    "macHostCanaryRunId",
    "windowsHostCanaryRunId",
    "linuxIntelHostCanaryRunId",
    "linuxNvidiaHostCanaryRunId",
    "manualCanaryRunId",
    "manualIntakeReleaseId",
    "manualHardwareJobId",
  ]) {
    assert.match(workflow, new RegExp(`      ${input}:`, "u"));
  }
  for (const forbidden of ["target_sha:", "supportMatrix:", "readinessRunId:"]) {
    assert.equal(workflow.includes(forbidden), false);
  }
  assert.equal(observer.includes("computeLabConfiguration"), false);
  assert.match(preflight, /validateServiceInstallations/u);
  assert.match(preflight, /computeEffectiveLabInfrastructure/u);
  assert.match(
    preflight,
    /browser-lab-canary-\$\{effective\.labInfrastructureDigest\}-\$\{process\.env\.GITHUB_RUN_ID\}/u,
  );
  assert.equal(workflow.includes("release-matrix"), false);
  assert.doesNotThrow(() => parse(workflow));
});

test("observer secret is isolated and canary cannot claim support readiness", () => {
  assert.match(observer, /environment: forge3d-trust-observer/u);
  assert.match(observer, /secrets\.TRUST_OBSERVER_PRIVATE_KEY/u);
  for (const value of [preflight, publisher]) {
    assert.equal(value.includes("TRUST_OBSERVER"), false);
    assert.equal(value.includes("secrets."), false);
    assert.equal(value.includes("browser-hardware-release-readiness"), false);
  }
  assert.match(preflight, /supportClaim: false/u);
  assert.match(
    preflight,
    /artifactDigest: `sha256:\$\{process\.env\.OBSERVATION_ARTIFACT_DIGEST\}`/u,
  );
  assert.match(publisher, /makes no browser support claim/u);
});

test("publisher has no checkout and carries an attested protected record validator", () => {
  assert.match(publisher, /environment: forge3d-web-release/u);
  assert.equal(publisher.includes("actions/checkout@"), false);
  assert.match(publisher, /test ! -d \.git/u);
  assert.match(publisher, /contents: write/u);
  assert.match(publisher, /attestations: read/u);
  assert.match(publisher, /for subject in preflight\/canary-assets\/\*/u);
  assert.match(preflight, /canary-publication-validator\/scripts/u);
  assert.match(preflight, /lab-canary-publication-record\.schema\.json/u);
  assert.match(
    publisher,
    /find preflight\/canary-publication-validator -type f \| sort/u,
  );
  assert.match(preflight, /recordType: "lab-canary-publication-candidate"/u);
  assert.match(publisher, /lab-canary-publication-record\.json/u);
  assert.match(publisher, /retention-days: 90/u);
});

test("separate least-privilege job verifies and attests the exact canary record", () => {
  assert.match(attester, /needs: publish-lab-canary/u);
  assert.match(attester, /runs-on: ubuntu-latest/u);
  for (const permission of [
    "actions: read",
    "id-token: write",
    "attestations: write",
    "artifact-metadata: write",
  ]) {
    assert.match(attester, new RegExp(permission, "u"));
  }
  for (const forbidden of ["contents:", "actions/checkout@", "environment:"]) {
    assert.equal(attester.includes(forbidden), false);
  }
  assert.match(attester, /publication_artifact_id/u);
  assert.match(attester, /publication_artifact_digest/u);
  assert.match(attester, /artifact\.workflow_run\?\.id !== Number\(process\.env\.GITHUB_RUN_ID\)/u);
  assert.match(attester, /lab-canary-publication-record\.schema\.json/u);
  assert.equal(
    attester.match(/SCHEMA_SHA256: ([0-9a-f]{64})/u)?.[1],
    createHash("sha256").update(publicationSchema).digest("hex"),
  );
  assert.match(attester, /validate\(record, schema\)/u);
  assert.match(attester, /bytes !== `\$\{canonical\(record\)\}\\n`/u);
  assert.match(attester, /record\.publicationRun\.attempt !== Number\(process\.env\.GITHUB_RUN_ATTEMPT\)/u);
  assert.match(attester, /subject-path: verified-publication\/lab-canary-publication-record\.json/u);
  assert.equal(attester.includes("canary-publication-validator/scripts"), false);
  assert.equal(attester.includes('from "./verified-publication'), false);
});

test("canary publication and readiness share the exact record filename and schema", () => {
  const produced = publisher.match(
    /create-publication-record \\\n+\s+(lab-canary-publication-record\.json)/u,
  )?.[1];
  const consumed = readinessWorkflow.match(
    /test -f canary-publication\/(lab-canary-publication-record\.json)/u,
  )?.[1];
  const producerSchema = preflight.match(
    /tests\/infrastructure\/(lab-canary-publication-record\.schema\.json)/u,
  )?.[1];
  const consumerSchema = readinessSource.match(
    /\.\.\/tests\/infrastructure\/(lab-canary-publication-record\.schema\.json)/u,
  )?.[1];
  assert.equal(produced, "lab-canary-publication-record.json");
  assert.equal(consumed, produced);
  assert.equal(consumerSchema, producerSchema);
  assert.match(readinessSource, /assertJsonSchema\(record, labCanaryPublicationSchema\)/u);
  assert.match(readinessSource, /record\.intake\.deletedAfterVerification/u);
  assert.match(readinessSource, /record\.publicationRun\.attempt/u);
  assert.match(readinessSource, /attestation\.signerWorkflow/u);
  assert.match(readinessSource, /selection\.artifact\.archiveSha256/u);
  assert.match(readinessSource, /bundleSha256: sha256Hex\(verification\)/u);
  assert.equal(readinessWorkflow.includes("intakeDeletedAfterVerification"), false);
  assert.equal(readinessSource.includes("intakeDeletedAfterVerification"), false);
  assert.doesNotThrow(() => parse(readinessWorkflow));
});

test("preflight, race, deletion, and readiness absence gates use 404-only validation", () => {
  assert.equal(
    preflight.match(/await requireGitHubResourceAbsent/gu)?.length,
    2,
  );
  assert.equal(
    publisher.match(/await requireGitHubResourceAbsent/gu)?.length,
    4,
  );
  assert.equal(
    readinessWorkflow.match(/await requireGitHubResourceAbsent/gu)?.length,
    2,
  );
  assert.equal(workflow.includes("if gh api"), false);
  assert.equal(readinessWorkflow.includes("if gh api"), false);
});

test("publisher closes fresh intake bytes, publishes once, then verifies immutable API bytes", () => {
  assert.match(preflight, /releaseName: `manual-media-\$\{asset\.id\}`/u);
  assert.match(
    preflight,
    /copyFileSync\([\s\S]*`resolved\/current-media-\$\{asset\.id\}`,[\s\S]*`canary-assets\/\$\{asset\.releaseName\}`/u,
  );
  assert.match(
    publisher,
    /bytes: \{ path: `preflight\/canary-assets\/\$\{asset\.releaseName\}` \}/u,
  );
  assert.match(
    publisher,
    /bytes: \{ path: `published-download\/\$\{asset\.releaseName\}` \}/u,
  );
  assert.match(publisher, /gh release create/u);
  assert.match(publisher, /--draft/u);
  assert.equal(
    logicalPublisher.match(
      /gh release edit "\$\{RELEASE_TAG\}" .*--draft=false/gu,
    )?.length,
    1,
  );
  assert.match(
    logicalPublisher,
    /gh release verify "\$\{RELEASE_TAG\}" .*--format json/u,
  );
  assert.match(
    publisher,
    /gh release verify-asset "\$\{RELEASE_TAG\}"[\s\S]*--format json/u,
  );
  assert.match(publisher, /gh api --paginate --slurp/u);
  assert.match(publisher, /assets\?per_page=100/u);
  assert.match(
    publisher,
    /releases\/assets\/\$\{asset_id\}"[\s\S]*Accept: application\/octet-stream/u,
  );
  assert.match(publisher, /release\.immutable !== true/u);
  assert.match(publisher, /published canary API\/byte digest mismatch/u);
  assert.equal(
    publisher.match(/verify-intake/gu)?.length,
    2,
    "intake/media must be freshly closed before publication and deletion",
  );
  assert.equal(
    publisher.match(/lab-canary-publication-record\.json/gu)?.length >= 2,
    true,
  );
});

test("every gh release subcommand has explicit repository context without checkout", () => {
  const commands = releaseCommands(publisher);
  assert.deepEqual(
    commands.map((command) => command.match(/^gh release ([a-z-]+)/u)?.[1]),
    ["create", "upload", "download", "edit", "verify", "verify-asset", "delete"],
  );
  assertReleaseCommandsHaveRepo(publisher);

  const unscoped = logicalPublisher.replace(
    ' --repo "${GITHUB_REPOSITORY}"',
    "",
  );
  assert.throws(
    () => assertReleaseCommandsHaveRepo(unscoped),
    /missing explicit repository context/u,
  );
  assert.equal(publisher.includes("actions/checkout@"), false);
  assert.match(publisher, /test ! -d \.git/u);
});

test("final verification precedes exact intake cleanup and the retained record is postpublication", () => {
  const publish = logicalPublisher.indexOf('gh release edit "${RELEASE_TAG}"');
  const releaseVerify = logicalPublisher.indexOf(
    'gh release verify "${RELEASE_TAG}"',
  );
  const assetVerify = logicalPublisher.indexOf(
    "gh release verify-asset",
    releaseVerify,
  );
  const publishedClosure = logicalPublisher.indexOf(
    "published canary API/byte digest mismatch",
    assetVerify,
  );
  const secondIntakeVerification = logicalPublisher.lastIndexOf("verify-intake");
  const retainedMediaClosure = logicalPublisher.indexOf(
    "published-download/${asset.releaseName}",
    publishedClosure,
  );
  const deletion = logicalPublisher.indexOf('gh release delete "${intake_tag}"');
  const record = logicalPublisher.indexOf("create-publication-record", deletion);
  for (const index of [
    publish,
    releaseVerify,
    assetVerify,
    publishedClosure,
    secondIntakeVerification,
    retainedMediaClosure,
    deletion,
    record,
  ]) {
    assert.notEqual(index, -1);
  }
  assert.ok(publish < releaseVerify);
  assert.ok(releaseVerify < assetVerify);
  assert.ok(assetVerify < publishedClosure);
  assert.ok(publishedClosure < retainedMediaClosure);
  assert.ok(retainedMediaClosure < secondIntakeVerification);
  assert.ok(secondIntakeVerification < deletion);
  assert.ok(secondIntakeVerification < deletion);
  assert.ok(deletion < record);
  assert.match(
    logicalPublisher,
    /gh release delete "\$\{intake_tag\}" .*--cleanup-tag .*--yes/u,
  );
  const afterPublish = logicalPublisher.slice(publish + 1);
  assert.equal(afterPublish.includes("gh release upload"), false);
  assert.equal(afterPublish.includes('gh release edit "${RELEASE_TAG}"'), false);
  assert.equal(afterPublish.includes('gh release delete "${RELEASE_TAG}"'), false);
  assert.match(preflight, /supportClaim: false/u);
});

function block(startId, nextId) {
  const start = workflow.indexOf(`  ${startId}:`);
  assert.notEqual(start, -1);
  const end = nextId ? workflow.indexOf(`  ${nextId}:`, start + 1) : workflow.length;
  assert.notEqual(end, -1);
  return workflow.slice(start, end);
}

function releaseCommands(value) {
  return value
    .replace(/\\\n\s*/gu, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("gh release "));
}

function assertReleaseCommandsHaveRepo(value) {
  const commands = releaseCommands(value);
  if (commands.length !== 7) {
    throw new Error(`expected seven gh release commands, found ${commands.length}`);
  }
  for (const command of commands) {
    if (!command.includes('--repo "${GITHUB_REPOSITORY}"')) {
      throw new Error(`gh release command missing explicit repository context: ${command}`);
    }
  }
}
