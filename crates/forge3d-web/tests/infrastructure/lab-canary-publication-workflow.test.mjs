import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const attributes = readFileSync(
  resolve(import.meta.dirname, "../../../../.gitattributes"),
  "utf8",
);
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
const selectorStep = parse(workflow).jobs["observe-lab-canary-publication-trust"].steps.find(
  (step) => step.name === "Validate positive numeric selectors",
);

test("publication contract inputs use canonical LF bytes", () => {
  for (const policy of [
    ".github/workflows/*.yml text eol=lf",
    "crates/forge3d-web/tests/infrastructure/*.json text eol=lf",
    "crates/forge3d-web/tests/infrastructure/*.mjs text eol=lf",
  ]) {
    assert.equal(
      attributes.split(/\r?\n/gu).includes(policy),
      true,
      `missing canonical LF policy: ${policy}`,
    );
  }
});

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
  for (const selector of [
    "MAC_RUN_ID",
    "WINDOWS_RUN_ID",
    "LINUX_INTEL_RUN_ID",
    "LINUX_NVIDIA_RUN_ID",
    "MANUAL_RUN_ID",
    "MANUAL_INTAKE_ID",
    "MANUAL_JOB_ID",
  ]) {
    assert.match(observer, new RegExp(`${selector}: \\$\\{\\{ inputs\\.`, "u"));
  }
  assert.equal(observer.includes("SELECTORS:"), false);
  assert.doesNotThrow(() => parse(workflow));
});

test("each canary selector rejects surrounding or embedded whitespace", () => {
  const selectorNames = [
    "MAC_RUN_ID",
    "WINDOWS_RUN_ID",
    "LINUX_INTEL_RUN_ID",
    "LINUX_NVIDIA_RUN_ID",
    "MANUAL_RUN_ID",
    "MANUAL_INTAKE_ID",
    "MANUAL_JOB_ID",
  ];
  const baseline = Object.fromEntries(selectorNames.map((name) => [name, "123"]));
  assert.equal(runSelectorValidation(baseline).status, 0);
  for (const selector of selectorNames) {
    for (const malformed of [" 123", "123 ", "12 3", "123\n"]) {
      const result = runSelectorValidation({ ...baseline, [selector]: malformed });
      assert.notEqual(result.status, 0, `${selector} accepted ${JSON.stringify(malformed)}`);
    }
  }
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

test("immutable-release administration stays in the attested observer boundary", () => {
  assert.match(observer, /verify-repository-trust\.mjs/u);
  assert.match(observer, /REPOSITORY_TRUST_OPERATION: publish-lab-canary/u);
  assert.equal(workflow.includes("/immutable-releases"), false);
  assert.equal(workflow.includes("immutable-release-settings.json"), false);
  assert.match(
    preflight,
    /immutableReleases\?\.enabled !== true/u,
  );
  assert.match(
    publisher,
    /immutableReleases\?\.enabled !== true/u,
  );
  assert.match(
    publisher,
    /exactKeys\(observation\.repositorySettings, \["immutableReleases"\]\)/u,
  );
  assert.equal(
    publisher.match(/observation\.repositorySettings\?\.immutableReleases\?\.enabled !== true/gu)?.length,
    2,
  );
  assert.match(publisher, /typeof immutableReleases\.enforcedByOwner !== "boolean"/u);
});

test("publisher has no checkout and carries an attested closed trust proof", () => {
  assert.match(publisher, /environment: forge3d-web-release/u);
  assert.equal(publisher.includes("actions/checkout@"), false);
  assert.match(publisher, /test ! -d \.git/u);
  assert.match(publisher, /contents: write/u);
  assert.match(publisher, /attestations: read/u);
  assert.match(publisher, /for subject in preflight\/canary-assets\/\*/u);
  assert.match(preflight, /repository-trust-publisher-proof\.json/u);
  assert.match(preflight, /lab-canary-publication-record\.schema\.json/u);
  assert.match(publisher, /preflight\/repository-trust-publisher-proof\.json/u);
  assert.match(preflight, /recordType: "lab-canary-publication-candidate"/u);
  assert.match(publisher, /lab-canary-publication-record\.json/u);
  assert.match(publisher, /retention-days: 90/u);
});

test("publisher revalidates the complete observation and exact release environment approvals", () => {
  assert.match(
    preflight,
    /EXPECTED_CONSUMERS: '\[\{"job":"validate-lab-canary","environment":"none"\},\{"job":"publish-lab-canary","environment":"forge3d-web-release"\}\]'/u,
  );
  for (const contract of [
    "observation-artifact.json",
    "unzip -Z1 observation.zip",
    "canonical(observation)",
    "observation.workflow.ref",
    "observation.run.attempt",
    "observation.currentMainSha",
    "observation.policySha256",
    "observation.workflowActionsLockSha256",
    "observationExpiresAt",
    "preflightExpiresAt",
  ]) assert.equal(publisher.includes(contract), true, contract);
  assert.match(publisher, /value\.environments\.length === 1/u);
  assert.match(publisher, /value\.environments\[0\]\?\.name === "forge3d-web-release"/u);
  assert.match(publisher, /value\.user\.login\.toLowerCase\(\)/u);
  for (const contract of [
    "preflightCreatedAt",
    'preflight.mode !== "laboratory-canary"',
    "preflight.supportClaim !== false",
    "preflight.repository !== process.env.GITHUB_REPOSITORY",
    "preflight.readiness.runId !== Number(process.env.GITHUB_RUN_ID)",
    "preflight.readiness.sha256 !== process.env.LAB_DIGEST",
    "manifest.labInfrastructureDigest !== process.env.LAB_DIGEST",
    "!preflightAssetsValid",
    "preflightExpiresAt - preflightCreatedAt > 30 * 60 * 1000",
  ]) assert.equal(publisher.includes(contract), true, contract);
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
  assert.match(attester, /artifact\.expired !== false/u);
  assert.match(attester, /artifact\.workflow_run\?\.repository_id !== 1259761852/u);
  assert.match(attester, /artifact\.workflow_run\?\.head_repository_id !== 1259761852/u);
  assert.match(attester, /artifact\.workflow_run\?\.head_sha !== process\.env\.EXPECTED_HEAD_SHA/u);
  assert.match(attester, /!\/\^\[0-9a-f\]\{64\}\$\/u\.test\(process\.env\.ARTIFACT_DIGEST\)/u);
  assert.match(attester, /artifact\.digest !== `sha256:\$\{process\.env\.ARTIFACT_DIGEST\}`/u);
  assert.match(attester, /= "\$\{ARTIFACT_DIGEST\}"/u);
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
    /writeFileSync\("(lab-canary-publication-record\.json)"/u,
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
    publisher.match(/await requireAbsent/gu)?.length,
    4,
  );
  assert.equal(
    publisher.match(/response\.status !== 404/gu)?.length,
    2,
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
    publisher.match(/manual canary intake identity or manifest bytes changed/gu)?.length,
    2,
    "intake/media must be freshly closed before publication and deletion",
  );
  assert.equal(publisher.includes("node preflight/"), false);
  assert.equal(publisher.includes('from "./preflight'), false);
  assert.equal(
    publisher.match(/lab-canary-publication-record\.json/gu)?.length >= 2,
    true,
  );
});

test("canary publisher rechecks both handoff expiries around the final absence race", () => {
  const mutation = publisher.slice(
    publisher.indexOf("Create draft, byte-verify closed assets, and publish exactly once"),
  );
  const absence = mutation.indexOf("await requireAbsent(`git/ref/tags/${tag}`)");
  const finalExpiry = mutation.indexOf("publication handoff expired immediately before mutation");
  const create = mutation.indexOf('gh release create "${RELEASE_TAG}"');
  assert.equal(mutation.match(/publication handoff expired (?:before|immediately before) mutation/gu)?.length, 2);
  assert.notEqual(absence, -1);
  assert.ok(absence < finalExpiry);
  assert.ok(finalExpiry < create);
  assert.match(mutation, /now >= observationExpiresAt/u);
  assert.match(mutation, /now >= preflightExpiresAt/u);
});

test("every protected canary publisher inline module is syntactically valid", () => {
  const modules = [...publisher.matchAll(
    /node --input-type=module --eval '\n([\s\S]*?)\n\s*'/gu,
  )];
  assert.ok(modules.length > 0);
  for (const [, source] of modules) {
    const result = spawnSync(
      process.execPath,
      ["--check", "--input-type=module"],
      { input: source, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
  }
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
  const secondIntakeVerification = logicalPublisher.lastIndexOf(
    "manual canary intake identity or manifest bytes changed",
  );
  const retainedMediaClosure = logicalPublisher.indexOf(
    "published-download/${asset.releaseName}",
    publishedClosure,
  );
  const deletion = logicalPublisher.indexOf('gh release delete "${intake_tag}"');
  const record = logicalPublisher.indexOf(
    'writeFileSync("lab-canary-publication-record.json"',
    deletion,
  );
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

function runSelectorValidation(environment) {
  const match = selectorStep.run.match(/--eval '([\s\S]*)'$/u);
  assert.ok(match, "numeric selector step must remain a Node eval");
  return spawnSync(process.execPath, ["--input-type=module", "--eval", match[1]], {
    env: { ...process.env, ...environment },
    encoding: "utf8",
  });
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
