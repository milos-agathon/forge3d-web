import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolvePackageRun({
  apiBase = "https://api.github.com",
  repository,
  packageRunId,
  trustedSha,
  token,
  fetchImpl = fetch,
}) {
  if (!/^[1-9][0-9]*$/u.test(String(packageRunId ?? ""))) {
    throw new Error("packageRunId must be a positive decimal ID");
  }
  if (!/^[0-9a-f]{40}$/u.test(trustedSha ?? "")) {
    throw new Error("trusted SHA must be a full lowercase commit SHA");
  }
  const run = await apiJson(
    `${apiBase}/repos/${repository}/actions/runs/${packageRunId}`,
    token,
    fetchImpl,
  );
  if (
    run.id !== Number(packageRunId) ||
    run.path !== ".github/workflows/browser-package.yml" ||
    run.head_sha !== trustedSha ||
    run.head_branch !== "main" ||
    run.conclusion !== "success" ||
    !["push", "workflow_dispatch"].includes(run.event)
  ) {
    throw new Error("package run is not the successful exact-main browser package run");
  }
  const artifacts = await apiJson(
    `${apiBase}/repos/${repository}/actions/runs/${packageRunId}/artifacts?per_page=100`,
    token,
    fetchImpl,
  );
  const expectedName = `browser-package-${trustedSha}`;
  const matches = (artifacts.artifacts ?? []).filter(
    (artifact) => artifact.name === expectedName,
  );
  if (
    matches.length !== 1 ||
    matches[0].expired ||
    matches[0].workflow_run?.id !== Number(packageRunId) ||
    matches[0].workflow_run?.head_sha !== trustedSha
  ) {
    throw new Error("package artifact is missing, duplicated, expired, or mismatched");
  }
  return {
    packageRunId: Number(packageRunId),
    packageArtifactId: matches[0].id,
    packageArtifactName: expectedName,
    packageArtifactDigest: matches[0].digest,
    packageWorkflowSha: run.head_sha,
    packageRunAttempt: run.run_attempt,
  };
}

async function apiJson(url, token, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API request failed with HTTP ${response.status}`);
  }
  return response.json();
}

function parseArguments(argv) {
  const result = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || result.has(key)) {
      throw new Error(`invalid or duplicate argument near ${key ?? "<end>"}`);
    }
    result.set(key, value);
  }
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArguments(process.argv.slice(2));
  const result = await resolvePackageRun({
    apiBase: process.env.GITHUB_API_URL,
    repository: process.env.GITHUB_REPOSITORY,
    packageRunId: args.get("--package-run-id"),
    trustedSha: args.get("--trusted-sha"),
    token: process.env.GITHUB_TOKEN,
  });
  writeFileSync(args.get("--output"), `${JSON.stringify(result, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(
      process.env.GITHUB_OUTPUT,
      [
        `package-artifact-id=${result.packageArtifactId}`,
        `package-artifact-name=${result.packageArtifactName}`,
        `package-artifact-digest=${result.packageArtifactDigest}`,
        "",
      ].join("\n"),
      { encoding: "utf8", flag: "a" },
    );
  }
  console.log(JSON.stringify({ ok: true, ...result }));
}
