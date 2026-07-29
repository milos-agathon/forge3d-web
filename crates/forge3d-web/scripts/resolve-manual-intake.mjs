import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repository = "milos-agathon/forge3d-web";
const prepareWorkflow =
  "milos-agathon/forge3d-web/.github/workflows/prepare-browser-manual-evidence.yml";

export function verifyManualIntake({
  release,
  intakeAsset,
  intake,
  intakeBytes,
  attestation,
  dispatch,
  packageManifest,
  actor,
  now = new Date(),
}) {
  const intakeSha256 = sha256(intakeBytes);
  if (
    !Number.isInteger(release?.id) ||
    release.id < 1 ||
    release.id !== dispatch.intakeReleaseId ||
    release.draft !== true ||
    release.tagName !== `manual-evidence-intake-${intake.prepareRun.id}` ||
    release.targetCommitish !== dispatch.trustedSha ||
    intakeAsset?.name !== "intake-manifest.json" ||
    intakeAsset?.sha256 !== intakeSha256 ||
    new Date(intake.expiresAt) <= new Date(now)
  ) {
    throw new Error("manual intake release, manifest asset, or expiry is invalid");
  }
  if (
    intake.repository !== repository ||
    intake.prepareWorkflow !==
      ".github/workflows/prepare-browser-manual-evidence.yml" ||
    intake.trustedSha !== dispatch.trustedSha ||
    intake.packageRunId !== dispatch.packageRunId ||
    intake.packageSha256 !== packageManifest.packageSha256 ||
    intake.assetId !== dispatch.assetId ||
    intake.hostId !== dispatch.hostId ||
    intake.expectedTester !== actor
  ) {
    throw new Error("manual intake does not match the promoted dispatch");
  }
  const expectedChecklist =
    dispatch.lane === "manual-mobile-multitouch"
      ? "mobile-multitouch"
      : dispatch.lane === "manual-safari-trackpad"
        ? "safari-trackpad"
        : dispatch.lane === "infrastructure-canary" &&
            dispatch.canaryMode === "manual"
          ? "infrastructure-manual-canary"
          : null;
  if (intake.checklistId !== expectedChecklist) {
    throw new Error("manual intake checklist is not valid for the promoted lane");
  }
  if (
    attestation?.repository !== repository ||
    attestation.signerWorkflow !== prepareWorkflow ||
    attestation.sourceRef !== "refs/heads/main" ||
    attestation.sourceDigest !== intake.prepareRun.workflowSha ||
    attestation.denySelfHostedRunners !== true ||
    attestation.subjectSha256 !== intakeSha256
  ) {
    throw new Error("manual intake subject attestation is invalid");
  }
  return {
    intakeReleaseId: release.id,
    checklistId: intake.checklistId,
    mediaChallenge: intake.mediaChallenge,
    intakeManifestSha256: intakeSha256,
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    if (
      !argv[index]?.startsWith("--") ||
      argv[index + 1] === undefined ||
      values.has(argv[index])
    ) {
      throw new Error(`invalid or duplicate argument near ${argv[index]}`);
    }
    values.set(argv[index], argv[index + 1]);
  }
  return values;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArguments(process.argv.slice(2));
  const input = JSON.parse(readFileSync(args.get("--input"), "utf8"));
  input.intakeBytes = readFileSync(args.get("--intake"));
  const result = verifyManualIntake(input);
  writeFileSync(args.get("--output"), `${JSON.stringify(result, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(JSON.stringify({ ok: true, intakeReleaseId: result.intakeReleaseId }));
}
