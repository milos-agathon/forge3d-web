import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

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

test("supported publication is manual-only and requires target, readiness, and SemVer tag", () => {
  for (const input of ["target_sha", "readinessRunId", "tag"]) {
    assert.match(workflow, new RegExp(`      ${input}:`, "u"));
  }
  assert.match(observer, /inputs\.target_sha != github\.sha/u);
  assert.equal(workflow.includes("pull_request:"), false);
  assert.equal(workflow.includes("workflow_call:"), false);
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
    assert.match(probe, /assertGitHubResourceAbsent/u);
    assert.match(probe, /git\/ref\/tags\//u);
  }
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
  const record = publisher.indexOf("create-publication-record");
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
