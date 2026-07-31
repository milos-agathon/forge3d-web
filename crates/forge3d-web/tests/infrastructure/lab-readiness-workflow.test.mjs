import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const workflow = readFileSync(
  resolve(
    import.meta.dirname,
    "../../../../.github/workflows/browser-lab-infrastructure-readiness.yml",
  ),
  "utf8",
).replace(/\r\n?/gu, "\n");
const readinessSource = readFileSync(
  resolve(import.meta.dirname, "../../scripts/compute-lab-readiness.mjs"),
  "utf8",
);
const observer = block(
  "observe-lab-readiness-trust",
  "browser-lab-infrastructure-readiness",
);
const readiness = block("browser-lab-infrastructure-readiness", null);

test("laboratory readiness accepts one package, four hosts, one manual canary, and one release", () => {
  for (const input of [
    "candidate_sha",
    "packageRunId",
    "macHostCanaryRunId",
    "windowsHostCanaryRunId",
    "linuxIntelHostCanaryRunId",
    "linuxNvidiaHostCanaryRunId",
    "manualCanaryRunId",
    "manualIntakeReleaseId",
    "manualHardwareJobId",
    "labCanaryReleaseId",
  ]) {
    assert.match(workflow, new RegExp(`      ${input}:`, "u"));
  }
  assert.match(observer, /inputs\.candidate_sha != github\.sha/u);
  assert.equal(workflow.includes("pull_request:"), false);
  assert.equal(workflow.includes("workflow_call:"), false);
});

test("only observer receives trust secret and computation cannot schedule product lanes", () => {
  assert.match(observer, /environment: forge3d-trust-observer/u);
  assert.match(observer, /secrets\.TRUST_OBSERVER_PRIVATE_KEY/u);
  assert.equal(readiness.includes("TRUST_OBSERVER"), false);
  assert.equal(readiness.includes("secrets."), false);
  assert.equal(readiness.includes("uses: ./.github/workflows/browser-hardware.yml"), false);
  assert.match(readiness, /run\.inputs\?\.lane !== "infrastructure-canary"/u);
  assert.match(readiness, /run\.inputs\?\.canaryMode !== "host"/u);
  assert.match(readiness, /lab-manual-canary-source\.json/u);
  assert.match(readiness, /lab-canary-assets\/manual-canary\.json/u);
  assert.match(
    readiness,
    /run\.path !== "\.github\/workflows\/submit-browser-manual-evidence\.yml"/u,
  );
  assert.match(readiness, /canary-publication-artifact\.json/u);
  assert.match(readiness, /verifyPackageManifestProvenance/u);
  assert.match(readiness, /packageRun: JSON\.parse\(readFileSync\("package-run\.json"/u);
  assert.match(readiness, /compute-lab-readiness\.mjs/u);
});

test("immutable computation name, permissions, fixed artifact, and attestation are pinned", () => {
  assert.match(readiness, /name: browser-lab-infrastructure-readiness/u);
  for (const permission of [
    "actions: read",
    "checks: read",
    "contents: read",
    "id-token: write",
    "attestations: write",
    "artifact-metadata: write",
  ]) {
    assert.match(readiness, new RegExp(permission, "u"));
  }
  assert.match(readiness, /name: browser-lab-infrastructure-readiness\n/u);
  assert.match(readiness, /retention-days: 90/u);
  assert.match(readiness, /actions\/attest@[0-9a-f]{40}/u);
});

test("selected API run identities are carried into shared readiness validation", () => {
  assert.match(readiness, /selectedRuns: \{/u);
  assert.match(readiness, /selectedRunId: Number\(selectedRunId\)/u);
  assert.match(readiness, /apiRunId: apiRun\.id/u);
  assert.match(readiness, /runAttempt: apiRun\.run_attempt/u);
  assert.match(readiness, /workflowPath: apiRun\.path/u);
  assert.match(readiness, /createdAt: apiRun\.created_at/u);
  assert.match(readiness, /completedAt: apiRun\.updated_at/u);
  assert.match(readiness, /status: apiRun\.status/u);
  assert.match(readiness, /conclusion: apiRun\.conclusion/u);
  assert.match(readiness, /headSha: apiRun\.head_sha/u);
  assert.match(readiness, /event: apiRun\.event/u);
  assert.match(readiness, /hardwareJobId: hostCanaries\.find/u);
  assert.match(readiness, /tests\/device\/device-matrix\.json/u);
  assert.match(readiness, /tests\/infrastructure\/https-origin-policy\.json/u);
  assert.match(readiness, /selectedRunId: Number\(process\.env\.MANUAL_RUN_ID\)/u);
  assert.match(readiness, /hardwareJobId: Number\(process\.env\.MANUAL_JOB_ID\)/u);
  assert.match(readiness, /intakeReleaseId: Number\(process\.env\.MANUAL_INTAKE_ID\)/u);
  assert.match(readiness, /selectedRunId: releaseManifest\.publicationRunId/u);
  assert.match(readiness, /apiRunId: publicationRun\.id/u);
  assert.match(readiness, /runAttempt: publicationRun\.run_attempt/u);
  assert.match(readiness, /workflowPath: publicationRun\.path/u);
  assert.match(readiness, /id: publicationArtifact\.id/u);
  assert.match(readiness, /digest: publicationArtifact\.digest/u);
  assert.match(readiness, /archiveSha256: sha256Hex\(readFileSync\("canary-publication\.zip"\)\)/u);
  assert.match(
    readiness,
    /gh attestation verify \\\n+\s+canary-publication\/lab-canary-publication-record\.json[\s\S]*--signer-workflow milos-agathon\/forge3d-web\/\.github\/workflows\/publish-browser-lab-canary\.yml[\s\S]*--source-ref refs\/heads\/main[\s\S]*--source-digest "\$\{GITHUB_SHA\}"[\s\S]*--deny-self-hosted-runners/u,
  );
  assert.match(readiness, /attestation: \{/u);
  assert.match(readiness, /signerWorkflow: "milos-agathon\/forge3d-web\/\.github\/workflows\/publish-browser-lab-canary\.yml"/u);
});

test("fresh CLI verification is closed and retained in the readiness input", () => {
  assert.match(readiness, /lab-canary-verification\/release\.json/u);
  assert.match(readiness, /lab-canary-verification\/assets-map\.json/u);
  assert.match(readiness, /lab-canary-verification\/verified-at\.txt/u);
  assert.match(readiness, /freshVerification: \{/u);
  assert.match(readiness, /recordSha256: sha256Hex\(publicationRecordBytes\)/u);
  assert.equal(readiness.includes("lab-canary-release-verification"), false);
  assert.equal(
    readiness.match(/outputBytesBase64: (?:bytes|freshReleaseVerificationBytes)\.toString\("base64"\)/gu)
      ?.length,
    2,
  );
  assert.match(
    readiness,
    /git\/ref\/tags\/\$\{encodeURIComponent\(process\.env\.INTAKE_TAG\)\}/u,
  );
});

test("production computation validates the final manifest schema before writing", () => {
  const cli = readinessSource.indexOf(
    "if (process.argv[1] === fileURLToPath(import.meta.url))",
  );
  const schemaAssertion = readinessSource.indexOf(
    "assertJsonSchema(output.manifest, browserLabInfrastructureReadinessSchema)",
    cli,
  );
  const write = readinessSource.indexOf("writeFileSync(process.argv[3]", cli);
  assert.notEqual(cli, -1);
  assert.notEqual(schemaAssertion, -1);
  assert.notEqual(write, -1);
  assert.ok(cli < schemaAssertion);
  assert.ok(schemaAssertion < write);
  assert.match(
    readinessSource,
    /browser-lab-infrastructure-readiness\.schema\.json/u,
  );
});

function block(startId, nextId) {
  const start = workflow.indexOf(`  ${startId}:`);
  assert.notEqual(start, -1);
  const end = nextId ? workflow.indexOf(`  ${nextId}:`, start + 1) : workflow.length;
  assert.notEqual(end, -1);
  return workflow.slice(start, end);
}
