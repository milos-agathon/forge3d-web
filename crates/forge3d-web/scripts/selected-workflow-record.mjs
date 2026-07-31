const FULL_SHA = /^[0-9a-f]{40}$/u;
const ARTIFACT_DIGEST = /^sha256:[0-9a-f]{64}$/u;

const artifactPrefixes = new Map([
  [
    ".github/workflows/browser-hardware.yml",
    "finalized-browser-hardware-",
  ],
  [
    ".github/workflows/submit-browser-manual-evidence.yml",
    "browser-manual-evidence-",
  ],
  [
    ".github/workflows/publish-browser-lab-canary.yml",
    "lab-canary-publication-",
  ],
]);

export function resolveSelectedWorkflowArtifact({
  run,
  artifacts,
  expected,
}) {
  const selectedRun = normalizeWorkflowRun(run, expected.inputs ?? {});
  const expectedBranch = expected.headBranch ?? branchFromRef(expected.ref);
  if (
    (expected.runId !== undefined && selectedRun.id !== expected.runId) ||
    (expected.runAttempt !== undefined &&
      selectedRun.attempt !== expected.runAttempt) ||
    selectedRun.path !== expected.path ||
    selectedRun.headBranch !== expectedBranch ||
    selectedRun.headSha !== expected.headSha ||
    selectedRun.event !== expected.event ||
    selectedRun.status !== expected.status ||
    selectedRun.conclusion !== expected.conclusion
  ) {
    throw new Error("selected workflow run tuple is invalid");
  }
  const prefix = artifactPrefixes.get(selectedRun.path);
  if (!prefix) {
    throw new Error("selected workflow has no fixed artifact contract");
  }
  const expectedName = `${prefix}${selectedRun.id}-${selectedRun.attempt}`;
  const matches = Array.isArray(artifacts)
    ? artifacts.filter((artifact) => artifact?.name === expectedName)
    : [];
  if (
    matches.length !== 1 ||
    matches[0].expired !== false ||
    !Number.isInteger(matches[0].id) ||
    matches[0].id < 1 ||
    !ARTIFACT_DIGEST.test(matches[0].digest ?? "")
  ) {
    throw new Error("selected workflow artifact tuple is invalid");
  }
  return {
    run: selectedRun,
    artifact: {
      id: matches[0].id,
      name: matches[0].name,
      digest: matches[0].digest,
    },
  };
}

export function verifySelectedWorkflowRecord({
  resolution,
  record,
  expectedInputs = {},
  runIdField = "runId",
  runAttemptField = "runAttempt",
  shaField = "trustedSha",
}) {
  const selectedRun = normalizeStoredResolution(resolution);
  if (!inputsEqual(selectedRun.inputs, expectedInputs)) {
    throw new Error("selected workflow inputs do not match the record");
  }
  if (record?.workflow !== undefined) {
    if (
      record.workflow?.runId !== selectedRun.id ||
      record.workflow.path !== selectedRun.path ||
      record.workflow.ref !== selectedRun.ref ||
      record.workflow.conclusion !== selectedRun.conclusion ||
      record.trustedSha !== selectedRun.headSha
    ) {
      throw new Error("matrix source does not match the selected workflow run");
    }
    return record;
  }
  if (
    record?.[runIdField] !== selectedRun.id ||
    (runAttemptField !== null &&
      record?.[runAttemptField] !== selectedRun.attempt) ||
    record?.[shaField] !== selectedRun.headSha
  ) {
    throw new Error("record does not match the selected workflow run");
  }
  return record;
}

export function bindSelectedWorkflowInputs(resolution, additionalInputs) {
  const selectedRun = normalizeStoredResolution(resolution);
  validateRelevantInputs(additionalInputs);
  const replacedInputs = Object.keys(additionalInputs).filter((name) =>
    Object.hasOwn(selectedRun.inputs, name),
  );
  if (replacedInputs.length > 0) {
    throw new Error(
      `selected workflow inputs cannot be replaced: ${replacedInputs.join(", ")}`,
    );
  }
  return {
    run: {
      ...resolution.run,
      inputs: {
        ...structuredClone(selectedRun.inputs),
        ...structuredClone(additionalInputs),
      },
    },
    artifact: { ...resolution.artifact },
  };
}

function normalizeWorkflowRun(run, relevantInputs) {
  validateRelevantInputs(relevantInputs);
  if (
    !Number.isInteger(run?.id) ||
    run.id < 1 ||
    !Number.isInteger(run.run_attempt) ||
    run.run_attempt < 1 ||
    typeof run.path !== "string" ||
    typeof run.head_branch !== "string" ||
    run.head_branch.length < 1 ||
    !FULL_SHA.test(run.head_sha ?? "") ||
    typeof run.event !== "string" ||
    typeof run.status !== "string" ||
    typeof run.conclusion !== "string"
  ) {
    throw new Error("selected workflow run is malformed");
  }
  return {
    id: run.id,
    attempt: run.run_attempt,
    path: run.path,
    headBranch: run.head_branch,
    ref: `refs/heads/${run.head_branch}`,
    headSha: run.head_sha,
    event: run.event,
    status: run.status,
    conclusion: run.conclusion,
    inputs: structuredClone(relevantInputs),
  };
}

function validateRelevantInputs(relevantInputs) {
  if (
    relevantInputs === null ||
    Array.isArray(relevantInputs) ||
    typeof relevantInputs !== "object" ||
    Object.values(relevantInputs).some((value) => value === undefined)
  ) {
    throw new Error("selected workflow relevant inputs are malformed");
  }
}

function normalizeStoredResolution(resolution) {
  const run = resolution?.run;
  const artifact = resolution?.artifact;
  const expectedPrefix = artifactPrefixes.get(run?.path);
  if (
    !Number.isInteger(run?.id) ||
    run.id < 1 ||
    !Number.isInteger(run.attempt) ||
    run.attempt < 1 ||
    typeof run.headBranch !== "string" ||
    run.ref !== `refs/heads/${run.headBranch}` ||
    !FULL_SHA.test(run.headSha ?? "") ||
    run.event !== "workflow_dispatch" ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    run.inputs === null ||
    Array.isArray(run.inputs) ||
    typeof run.inputs !== "object" ||
    !expectedPrefix ||
    !Number.isInteger(artifact?.id) ||
    artifact.id < 1 ||
    artifact.name !== `${expectedPrefix}${run.id}-${run.attempt}` ||
    !ARTIFACT_DIGEST.test(artifact.digest ?? "")
  ) {
    throw new Error("stored workflow selection is invalid");
  }
  return run;
}

function branchFromRef(ref) {
  const match = /^refs\/heads\/(.+)$/u.exec(ref ?? "");
  if (!match) throw new Error("expected workflow ref is invalid");
  return match[1];
}

function inputsEqual(actual, expected) {
  const actualEntries = Object.entries(actual);
  const expectedEntries = Object.entries(expected);
  return (
    actualEntries.length === expectedEntries.length &&
    expectedEntries.every(
      ([name, value]) =>
        value !== undefined &&
        Object.hasOwn(actual, name) &&
        String(actual[name]) === String(value),
    )
  );
}
