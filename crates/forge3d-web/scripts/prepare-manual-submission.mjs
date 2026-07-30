import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "./canonical-json.mjs";

export function parseManualSubmissionDispatch(inputs) {
  const intakeReleaseId = positiveId(inputs.intakeReleaseId, "intake release");
  const manualSessionRunId = positiveId(
    inputs.manualSessionRunId,
    "manual session run",
  );
  const hardwareJobId = positiveId(inputs.hardwareJobId, "hardware job");
  const mediaAssetIds = JSON.parse(inputs.mediaAssetIds);
  if (
    canonicalJson(mediaAssetIds) !== inputs.mediaAssetIds ||
    !Array.isArray(mediaAssetIds) ||
    mediaAssetIds.length < 1 ||
    mediaAssetIds.some((id) => !Number.isInteger(id) || id < 1) ||
    new Set(mediaAssetIds).size !== mediaAssetIds.length
  ) {
    throw new Error("media asset IDs must be a canonical unique numeric array");
  }
  const stepResults = JSON.parse(inputs.stepResults);
  if (
    canonicalJson(stepResults) !== inputs.stepResults ||
    stepResults === null ||
    Array.isArray(stepResults) ||
    typeof stepResults !== "object"
  ) {
    throw new Error("step_results must be a canonical JSON object");
  }
  return {
    intakeReleaseId,
    manualSessionRunId,
    hardwareJobId,
    mediaAssetIds,
    stepResults,
  };
}

export function prepareManualSubmission({
  dispatch,
  releaseApi,
  intake,
  intakeBytes,
  signedSession,
  signedSessionBytes,
  sessionFinalizer,
  sessionFinalizerBytes,
  sessionRunApi,
  hardwareJobApi,
  releaseAssets,
  mediaBytesById,
  approvals,
  implementationActors,
  actor,
  submissionRun,
}) {
  const parsed = parseManualSubmissionDispatch(dispatch);
  if (
    releaseApi.id !== parsed.intakeReleaseId ||
    sessionRunApi.id !== parsed.manualSessionRunId ||
    hardwareJobApi.id !== parsed.hardwareJobId
  ) {
    throw new Error("submission IDs do not resolve to the supplied records");
  }
  const intakeAsset = releaseAssets.find(
    (asset) => asset.name === "intake-manifest.json",
  );
  if (!intakeAsset) {
    throw new Error("intake manifest asset is missing");
  }
  const selectedAssets = parsed.mediaAssetIds.map((id) => {
    const matches = releaseAssets.filter((asset) => asset.id === id);
    const bytes = mediaBytesById.get(id);
    if (matches.length !== 1 || !bytes) {
      throw new Error(`selected release asset does not resolve exactly once: ${id}`);
    }
    const asset = matches[0];
    const digest = apiDigest(asset.digest);
    return {
      id,
      name: asset.name,
      uploader: asset.uploader.login,
      size: asset.size,
      mimeType: asset.content_type,
      createdAt: asset.created_at,
      apiSha256: digest,
      sha256: sha256(bytes),
    };
  });
  const session = {
    ...signedSession.record,
    controllerSignatureSha256: sha256(
      Buffer.from(signedSession.signature.value, "base64url"),
    ),
  };
  return {
    release: {
      id: releaseApi.id,
      draft: releaseApi.draft,
      tagName: releaseApi.tag_name,
      targetCommitish: releaseApi.target_commitish,
    },
    intake,
    intakeSha256: sha256(intakeBytes),
    intakeManifestAssetId: intakeAsset.id,
    intakeAttestation: {
      repository: "milos-agathon/forge3d-web",
      signerWorkflow:
        "milos-agathon/forge3d-web/.github/workflows/prepare-browser-manual-evidence.yml",
      sourceRef: "refs/heads/main",
      sourceDigest: intake.prepareRun.workflowSha,
      subjectSha256: sha256(intakeBytes),
      denySelfHostedRunners: true,
    },
    session,
    signedSessionSha256: signedSession.sha256,
    signedSessionSubjectSha256: sha256(signedSessionBytes),
    sessionRun: {
      id: sessionRunApi.id,
      runAttempt: sessionRunApi.run_attempt,
      path: sessionRunApi.path,
      headBranch: sessionRunApi.head_branch,
      headSha: sessionRunApi.head_sha,
      event: sessionRunApi.event,
      status: sessionRunApi.status,
      conclusion: sessionRunApi.conclusion,
    },
    hardwareJob: {
      id: hardwareJobApi.id,
      name: hardwareJobApi.name,
      status: hardwareJobApi.status,
      conclusion: hardwareJobApi.conclusion,
      runnerId: hardwareJobApi.runner_id,
      runnerName: hardwareJobApi.runner_name,
    },
    sessionFinalizer,
    sessionFinalizerSubjectSha256: sha256(sessionFinalizerBytes),
    sessionAttestation: {
      repository: "milos-agathon/forge3d-web",
      signerWorkflow:
        "milos-agathon/forge3d-web/.github/workflows/browser-hardware.yml",
      sourceRef: "refs/heads/main",
      sourceDigest: signedSession.record.workflowSha,
      denySelfHostedRunners: true,
      sessionSubjectSha256: sha256(signedSessionBytes),
      finalizerSubjectSha256: sha256(sessionFinalizerBytes),
    },
    selectedAssets,
    releaseAssets: releaseAssets.map((asset) => ({ id: asset.id })),
    stepResults: parsed.stepResults,
    actor,
    approvals,
    implementationActors,
    submissionRun,
  };
}

function apiDigest(value) {
  const match = /^sha256:([0-9a-f]{64})$/u.exec(value ?? "");
  if (!match) throw new Error("release asset API SHA-256 digest is unavailable");
  return match[1];
}

function positiveId(value, label) {
  if (!/^[1-9][0-9]*$/u.test(String(value ?? ""))) {
    throw new Error(`${label} ID must be a positive decimal`);
  }
  return Number(value);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const input = JSON.parse(readFileSync(process.argv[2], "utf8"));
  input.intakeBytes = readFileSync(input.intakePath);
  input.signedSessionBytes = readFileSync(input.signedSessionPath);
  input.sessionFinalizerBytes = readFileSync(input.sessionFinalizerPath);
  input.mediaBytesById = new Map(
    Object.entries(input.mediaPaths).map(([id, path]) => [
      Number(id),
      readFileSync(path),
    ]),
  );
  delete input.intakePath;
  delete input.signedSessionPath;
  delete input.sessionFinalizerPath;
  delete input.mediaPaths;
  const output = prepareManualSubmission(input);
  writeFileSync(process.argv[3], `${JSON.stringify(output, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(JSON.stringify({ ok: true, mediaCount: output.selectedAssets.length }));
}
