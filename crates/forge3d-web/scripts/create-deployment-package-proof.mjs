import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "./canonical-json.mjs";
import { assertBrokerPackageManifest } from "../../../tools/browser-lab-broker/src/deployment-provenance.mjs";
import { assertControllerPackageManifest } from "../../../tools/browser-lab-controller/src/deployment-provenance.mjs";

export function createDeploymentPackageProof({
  deployment,
  run,
  artifact,
  artifactZipBytes,
  packageManifest,
  packageManifestBytes,
  packageManifestName,
  archiveBytes,
  archiveName,
}) {
  const service = deployment?.service;
  const workflow =
    `.github/workflows/browser-lab-${service}.yml`;
  const signerWorkflow =
    `milos-agathon/forge3d-web/${workflow}`;
  const manifestName =
    service === "broker"
      ? "broker-package-manifest.json"
      : "controller-package-manifest.json";
  if (
    !["broker", "controller"].includes(service) ||
    packageManifestName !== manifestName ||
    run?.id !== deployment.packageRun.id ||
    run.run_attempt !== deployment.packageRun.attempt ||
    run.path !== workflow ||
    run.head_branch !== "main" ||
    run.head_sha !== deployment.source.targetSha ||
    (service === "broker" &&
      !["push", "workflow_dispatch"].includes(run.event)) ||
    (service === "controller" && run.event !== "workflow_dispatch") ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    artifact?.id !== deployment.packageRun.artifact.id ||
    artifact.name !== deployment.packageRun.artifact.name ||
    artifact.name !==
      `browser-lab-${service}-${deployment.source.targetSha}-${run.id}-${run.run_attempt}` ||
    artifact.digest !== deployment.packageRun.artifact.digest ||
    artifact.expired !== false ||
    artifact.workflow_run?.id !== run.id ||
    sha256(artifactZipBytes) !== artifact.digest.slice("sha256:".length) ||
    sha256(packageManifestBytes) !== deployment.packageManifest.sha256 ||
    basename(archiveName) !== deployment.archive.name ||
    sha256(archiveBytes) !== deployment.archive.sha256 ||
    deployment.packageManifest.attestation.verified !== true ||
    deployment.packageManifest.attestation.repository !==
      "milos-agathon/forge3d-web" ||
    deployment.packageManifest.attestation.signerWorkflow !==
      signerWorkflow ||
    deployment.packageManifest.attestation.sourceRef !==
      "refs/heads/main" ||
    deployment.packageManifest.attestation.sourceDigest !==
      deployment.source.targetSha ||
    deployment.packageManifest.attestation.denySelfHostedRunners !== true
  ) {
    throw new Error("deployed package run or artifact identity is invalid");
  }
  validateManifest(deployment, packageManifest);
  return {
    service,
    serviceIdentity: deployment.serviceIdentity,
    run: {
      id: run.id,
      attempt: run.run_attempt,
      path: run.path,
      headSha: run.head_sha,
      event: run.event,
      status: run.status,
      conclusion: run.conclusion,
    },
    artifact: {
      id: artifact.id,
      name: artifact.name,
      digest: artifact.digest,
    },
    packageManifest: {
      name: packageManifestName,
      sha256: sha256(packageManifestBytes),
      value: structuredClone(packageManifest),
    },
    archive: {
      name: basename(archiveName),
      sha256: sha256(archiveBytes),
    },
    hostedAttestationVerification: {
      verified: true,
      repository: "milos-agathon/forge3d-web",
      signerWorkflow,
      sourceRef: "refs/heads/main",
      sourceDigest: deployment.source.targetSha,
      denySelfHostedRunners: true,
    },
  };
}

function validateManifest(deployment, manifest) {
  if (deployment.service === "broker") {
    assertBrokerPackageManifest(manifest);
    if (
      manifest.repository !== deployment.source.repository ||
      manifest.targetSha !== deployment.source.targetSha ||
      manifest.workflowSha !== deployment.source.workflowSha ||
      manifest.archive.name !== deployment.archive.name ||
      manifest.archive.sha256 !== deployment.archive.sha256 ||
      manifest.configurationSha256 !==
        deployment.configuration.sha256 ||
      manifest.brokerProtocolVersion !== deployment.protocols.broker ||
      manifest.cleanupProtocolVersion !== deployment.protocols.cleanup
    ) {
      throw new Error("broker manifest does not match deployed provenance");
    }
    return;
  }
  assertControllerPackageManifest(manifest);
  if (
    manifest.targetSha !== deployment.source.targetSha ||
    manifest.workflowSha !== deployment.source.workflowSha ||
    manifest.archive !== deployment.archive.name ||
    manifest.archiveSha256 !== deployment.archive.sha256 ||
    sha256(Buffer.from(canonicalJson(manifest.files))) !==
      deployment.configuration.sha256
  ) {
    throw new Error("controller manifest does not match deployed provenance");
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [
    deploymentPath,
    runPath,
    artifactPath,
    artifactZipPath,
    packageManifestPath,
    archivePath,
    outputPath,
  ] = process.argv.slice(2);
  const packageManifestBytes = readFileSync(packageManifestPath);
  const result = createDeploymentPackageProof({
    deployment: JSON.parse(readFileSync(deploymentPath, "utf8")),
    run: JSON.parse(readFileSync(runPath, "utf8")),
    artifact: JSON.parse(readFileSync(artifactPath, "utf8")),
    artifactZipBytes: readFileSync(artifactZipPath),
    packageManifest: JSON.parse(packageManifestBytes.toString("utf8")),
    packageManifestBytes,
    packageManifestName: basename(packageManifestPath),
    archiveBytes: readFileSync(archivePath),
    archiveName: basename(archivePath),
  });
  writeFileSync(outputPath, `${canonicalJson(result)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      ok: true,
      service: result.service,
      serviceIdentity: result.serviceIdentity,
    }),
  );
}
