import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const workflow = readFileSync(
  resolve(
    import.meta.dirname,
    "../../../../.github/workflows/publish-web-release.yml",
  ),
  "utf8",
);
const observer = block(
  "observe-release-publication-trust",
  "validate-release-candidate",
);
const preflight = block("validate-release-candidate", "publish-release");
const publisher = block("publish-release", "attest-postpublication-record");
const attester = block("attest-postpublication-record", null);
const publicationSchema = readFileSync(
  resolve(
    import.meta.dirname,
    "./browser-release-publication-record.schema.json",
  ),
);
const selectorStep = parse(workflow).jobs["observe-release-publication-trust"].steps.find(
  (step) => step.name === "Validate positive numeric selectors",
);

test("supported publication is manual-only and requires target, readiness, and SemVer tag", () => {
  for (const input of ["target_sha", "readinessRunId", "tag"]) {
    assert.match(workflow, new RegExp(`      ${input}:`, "u"));
  }
  assert.match(observer, /inputs\.target_sha != github\.sha/u);
  assert.equal(workflow.includes("pull_request:"), false);
  assert.equal(workflow.includes("workflow_call:"), false);
  assert.match(observer, /READINESS_RUN_ID: \$\{\{ inputs\.readinessRunId \}\}/u);
  assert.match(observer, /\^\[1-9\]\[0-9\]\*\$/u);
});

test("release readiness selector rejects surrounding or embedded whitespace", () => {
  const match = selectorStep.run.match(/--eval '([\s\S]*)'$/u);
  assert.ok(match, "numeric selector step must remain a Node eval");
  assert.equal(runSelectorValidation(match[1], "123").status, 0);
  for (const malformed of [" 123", "123 ", "12 3", "123\n"]) {
    assert.notEqual(
      runSelectorValidation(match[1], malformed).status,
      0,
      `readiness selector accepted ${JSON.stringify(malformed)}`,
    );
  }
});

test("publisher revalidates the complete observation and exact release environment approvals", () => {
  assert.match(
    preflight,
    /EXPECTED_CONSUMERS: '\[\{"job":"validate-release-candidate","environment":"none"\},\{"job":"publish-release","environment":"forge3d-web-release"\}\]'/u,
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
    "preflightCreatedAt",
    "preflightExpiresAt",
    "repository-trust-publisher-proof.json",
    "publisher-readiness-run.json",
    "publisher-readiness-artifact.json",
    'preflight.mode !== "supported-release"',
    "preflight.supportClaim !== true",
    "preflight.repository !== process.env.GITHUB_REPOSITORY",
    "preflight.readiness.runId !== Number(process.env.READINESS_RUN_ID)",
    "preflight.readiness.artifactId !== readinessArtifact.id",
    "!readinessBytes.equals(independentReadinessBytes)",
    "!preflightAssetsValid",
    "preflightExpiresAt - preflightCreatedAt > 30 * 60 * 1000",
  ]) assert.equal(publisher.includes(contract), true, contract);
  assert.match(publisher, /value\.environments\.length === 1/u);
  assert.match(publisher, /value\.environments\[0\]\?\.name === "forge3d-web-release"/u);
  assert.match(publisher, /value\.user\.login\.toLowerCase\(\)/u);
});

test("observer secret is isolated from read-only preflight and protected publisher", () => {
  assert.match(observer, /environment: forge3d-trust-observer/u);
  assert.match(observer, /secrets\.TRUST_OBSERVER_PRIVATE_KEY/u);
  for (const value of [preflight, publisher]) {
    assert.equal(value.includes("TRUST_OBSERVER"), false);
    assert.equal(value.includes("secrets."), false);
  }
  assert.match(preflight, /browser-hardware-release-readiness/u);
  assert.match(preflight, /validateReleaseCandidate/u);
  assert.match(
    preflight,
    /artifactDigest: `sha256:\$\{process\.env\.OBSERVATION_ARTIFACT_DIGEST\}`/u,
  );
  assert.match(preflight, /selectedRun:/u);
  assert.match(preflight, /attempt: selectedRun\.run_attempt/u);
  assert.match(preflight, /path: selectedRun\.path/u);
});

test("immutable-release administration stays in the attested observer boundary", () => {
  assert.match(observer, /verify-repository-trust\.mjs/u);
  assert.match(observer, /REPOSITORY_TRUST_OPERATION: publish-web-release/u);
  assert.equal(workflow.includes("/immutable-releases"), false);
  assert.equal(workflow.includes("immutable-release-settings.json"), false);
  assert.match(
    preflight,
    /immutableReleases\?\.enabled === true/u,
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

test("publisher has no checkout and performs approval, draft-first, byte, CLI, and intake gates", () => {
  assert.match(publisher, /environment: forge3d-web-release/u);
  assert.equal(publisher.includes("actions/checkout@"), false);
  assert.match(publisher, /test ! -d \.git/u);
  assert.match(publisher, /contents: write/u);
  assert.match(publisher, /attestations: read/u);
  assert.match(publisher, /gh release create/u);
  assert.match(publisher, /--draft/u);
  assert.match(
    publisher,
    /gh release edit "\$\{RELEASE_TAG\}" --repo "\$\{GITHUB_REPOSITORY\}" --draft=false/u,
  );
  assert.match(
    publisher,
    /gh release verify "\$\{RELEASE_TAG\}" --repo "\$\{GITHUB_REPOSITORY\}" --format json > publication-proof\/release-verify\.json/u,
  );
  assert.match(
    publisher,
    /gh release verify-asset "\$\{RELEASE_TAG\}" "published-download\/\$\{asset_name\}" --repo "\$\{GITHUB_REPOSITORY\}" --format json > "\$\{proof_path\}"/u,
  );
  assert.match(publisher, /manual-media-sources\.json/u);
  assert.match(publisher, /retention-days: 90/u);
});

test("publisher rechecks both handoff expiries around the final absence race", () => {
  const mutation = publisher.slice(
    publisher.indexOf("Create draft, byte-verify closed assets, and publish exactly once"),
  );
  const absence = mutation.indexOf("]) await assertAbsent(resourcePath);");
  const finalExpiry = mutation.indexOf("publication handoff expired immediately before mutation");
  const create = mutation.indexOf('gh release create "${RELEASE_TAG}"');
  assert.equal(mutation.match(/publication handoff expired (?:before|immediately before) mutation/gu)?.length, 2);
  assert.notEqual(absence, -1);
  assert.ok(absence < finalExpiry);
  assert.ok(finalExpiry < create);
  assert.match(mutation, /now >= observationExpiresAt/u);
  assert.match(mutation, /now >= preflightExpiresAt/u);
});

test("separate least-privilege job verifies and attests the exact postpublication record", () => {
  assert.match(attester, /needs: publish-release/u);
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
  assert.match(attester, /browser-release-publication-record\.schema\.json/u);
  assert.equal(
    attester.match(/SCHEMA_SHA256: ([0-9a-f]{64})/u)?.[1],
    createHash("sha256").update(publicationSchema).digest("hex"),
  );
  assert.match(attester, /validate\(record, schema\)/u);
  assert.match(attester, /bytes !== `\$\{canonical\(record\)\}\\n`/u);
  assert.match(attester, /record\.publicationRun\.attempt !== Number\(process\.env\.GITHUB_RUN_ATTEMPT\)/u);
  assert.match(attester, /subject-path: verified-publication\/release-publication-record\.json/u);
  assert.equal(attester.includes("publication-validator/scripts"), false);
  assert.equal(attester.includes('from "./verified-publication'), false);
});

test("every no-checkout gh release command carries exact repository context", () => {
  const commands = ghReleaseCommands(publisher);
  assert.equal(commands.length, 8);
  assertReleaseRepositoryContext(commands);
  for (let index = 0; index < commands.length; index += 1) {
    const mutated = commands.map((command, commandIndex) =>
      commandIndex === index
        ? command.replace(/\s+--repo\s+"\$\{GITHUB_REPOSITORY\}"/u, "")
        : command,
    );
    assert.throws(
      () => assertReleaseRepositoryContext(mutated),
      /requires exact repository context/u,
    );
  }
});

test("preflight, publisher race, and deletion prove absence only through the exact-404 helper", () => {
  assert.equal(workflow.includes("if gh api"), false);
  const preflightProbe = preflight.slice(
    preflight.indexOf("Validate SemVer tag, immutable setting, and absent release"),
    preflight.indexOf("Copy exact package and evidence assets by numeric artifact ID"),
  );
  const raceProbe = publisher.slice(
    publisher.indexOf("Create draft, byte-verify closed assets, and publish exactly once"),
    publisher.indexOf("gh release create"),
  );
  const deletionProbe = publisher.slice(
    publisher.indexOf("Delete exact manual intakes"),
    publisher.indexOf("Create checked-schema post-publication record"),
  );
  for (const probe of [preflightProbe, raceProbe, deletionProbe]) {
    assert.match(probe, /assertGitHubResourceAbsent|assertAbsent/u);
    assert.match(probe, /git\/ref\/tags\//u);
  }
  assert.match(raceProbe, /response\.status !== 404/u);
  assert.match(deletionProbe, /response\.status !== 404/u);
  assert.match(preflightProbe, /releases\/tags\/\$\{process\.env\.RELEASE_TAG\}/u);
  assert.match(raceProbe, /releases\/tags\/\$\{process\.env\.RELEASE_TAG\}/u);
  assert.match(deletionProbe, /releases\/\$\{process\.argv\[1\]\}/u);
});

test("package manifest provenance is joined to the resolved API run before release assembly", () => {
  const packageStep = preflight.slice(
    preflight.indexOf("Copy exact package and evidence assets by numeric artifact ID"),
    preflight.indexOf("Resolve implementation actors and create closed preflight"),
  );
  const resolve = preflight.indexOf("resolve-hardware-promotion.mjs");
  const attest = preflight.indexOf(
    "gh attestation verify package-assets/browser-package-manifest.json",
  );
  const join = preflight.indexOf("verifyPackageManifestProvenance");
  const copy = preflight.indexOf("for asset in package-assets/*");
  assert.ok(resolve > -1 && attest > resolve && join > attest && copy > join);
  for (const field of [
    "package-run.json",
    "browser-package-manifest.json",
  ]) {
    assert.equal(preflight.includes(field), true);
  }
  assert.match(packageStep, /GH_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.match(packageStep, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/u);
});

test("manual media is fetched by numeric ID twice and rebound to exact intake metadata", () => {
  assert.match(
    preflight,
    /releases\/assets\/\$\{asset_id\}.*manual-current\/\$\{release_id\}-\$\{asset_id\}/su,
  );
  assert.match(preflight, /validateManualMediaIntake/u);
  assert.match(preflight, /attestedMediaBytes/u);
  assert.match(preflight, /createManualMediaSourcePlan/u);
  assert.match(publisher, /Re-fetch and re-attest exact manual bytes immediately before assembly/u);
  for (const field of [
    "tag_name !== intake.tagName",
    "target_commitish !== process.env.TARGET_SHA",
    "release.draft !== true",
    "metadata.uploader?.login !== expected.uploader",
    "metadata.content_type !== expected.mimeType",
    "metadata.created_at !== expected.createdAt",
    "metadata.digest !== `sha256:${expected.apiSha256}`",
  ]) {
    assert.equal(publisher.includes(field), true, `missing live intake check: ${field}`);
  }
});

test("candidate is schema-backed and contains no impossible post-publication claims", () => {
  assert.match(preflight, /createBrowserReleaseCandidate/u);
  assert.match(preflight, /browser-release-manifest\.schema\.json/u);
  assert.equal(preflight.includes("releaseVerified: true"), false);
  assert.equal(preflight.includes("allAssetsVerified: true"), false);
  assert.equal(preflight.includes("publishedAt"), false);
});

test("publication proof is post-publish, closed, schema-validated, and retained without asset mutation", () => {
  const publish = publisher.indexOf('gh release edit "${RELEASE_TAG}"');
  const releaseVerify = publisher.indexOf('gh release verify "${RELEASE_TAG}"');
  const assetVerify = publisher.indexOf('gh release verify-asset "${RELEASE_TAG}"');
  const apiDigest = publisher.indexOf('actual?.digest !== `sha256:${expected.sha256}`');
  const deleteIntake = publisher.indexOf('gh release delete "${intake_tag}"');
  const record = publisher.indexOf('writeFileSync("release-publication-record.json"');
  assert.ok(publish > -1 && releaseVerify > publish);
  assert.ok(assetVerify > releaseVerify);
  assert.ok(apiDigest > assetVerify);
  assert.ok(deleteIntake > apiDigest);
  assert.ok(record > deleteIntake);
  assert.equal(publisher.indexOf("gh release upload", publish), -1);
  assert.equal(publisher.indexOf("gh release edit", publish + 1), -1);
  assert.match(workflow, /browser-release-publication-record\.schema\.json/u);
  assert.match(publisher, /publicationRun: \{/u);
  assert.match(publisher, /id: Number\(process\.env\.GITHUB_RUN_ID\)/u);
  assert.match(publisher, /attempt: Number\(process\.env\.GITHUB_RUN_ATTEMPT\)/u);
  assert.match(publisher, /workflowPath: "\.github\/workflows\/publish-web-release\.yml"/u);
  assert.match(publisher, /publication-proof\/published-assets\.json/u);
  assert.match(publisher, /release\.immutable !== true/u);
  assert.match(publisher, /release\.published_at/u);
  assert.equal(publisher.includes("node preflight/"), false);
  assert.equal(publisher.includes('from "./preflight'), false);
});

test("every protected web publisher inline module is syntactically valid", () => {
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

test("intake deletion derives only from the checked manual-media source plan", () => {
  const deletionStep = publisher.slice(
    publisher.indexOf("Delete exact manual intakes"),
    publisher.indexOf("Create checked-schema post-publication record"),
  );
  assert.match(deletionStep, /manual-media-sources\.json/u);
  assert.match(deletionStep, /intake\.releaseId/u);
  assert.match(deletionStep, /intake\.tagName/u);
  assert.equal(deletionStep.includes("manual-evidence.json"), false);
});

function block(startId, nextId) {
  const start = workflow.indexOf(`  ${startId}:`);
  assert.notEqual(start, -1);
  const end = nextId ? workflow.indexOf(`  ${nextId}:`, start + 1) : workflow.length;
  assert.notEqual(end, -1);
  return workflow.slice(start, end);
}

function runSelectorValidation(script, value) {
  return spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    env: { ...process.env, READINESS_RUN_ID: value },
    encoding: "utf8",
  });
}

function ghReleaseCommands(text) {
  const lines = text.split(/\r?\n/u);
  const commands = [];
  for (let index = 0; index < lines.length; index += 1) {
    const invocation = lines[index].match(/\bgh release\s.+$/u)?.[0];
    if (!invocation) continue;
    const command = [invocation.trim()];
    while (command.at(-1).endsWith("\\")) {
      index += 1;
      assert.ok(index < lines.length, "unterminated gh release command");
      command.push(lines[index].trim());
    }
    commands.push(command.join(" "));
  }
  return commands;
}

function assertReleaseRepositoryContext(commands) {
  for (const command of commands) {
    const contexts = command.match(/--repo\s+"\$\{GITHUB_REPOSITORY\}"/gu) ?? [];
    if (contexts.length !== 1) {
      throw new Error(`gh release requires exact repository context: ${command}`);
    }
  }
}
