import { readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { createRunnerAuthorization } from "./hardware-orchestration.mjs";

export async function pollAndAuthorize({
  apiBase = "https://api.github.com",
  repository,
  token,
  runId,
  runAttempt,
  promotion,
  policy,
  fetchImpl = fetch,
  now = () => new Date(),
  delayImpl = delay,
  timeoutMs = 15 * 60 * 1000,
}) {
  const startedAt = now().getTime();
  for (;;) {
    const jobs = await apiJson(
      `${apiBase}/repos/${repository}/actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100`,
      token,
      fetchImpl,
    );
    const hardwareMatches = (jobs.jobs ?? []).filter(
      (job) =>
        job.name === "Browser Hardware / Ephemeral Execution" &&
        job.status === "queued",
    );
    if (hardwareMatches.length > 1) {
      throw new Error("multiple queued hardware jobs match one authorization");
    }
    if (hardwareMatches.length === 1) {
      const promotionJob = uniqueJob(
        jobs.jobs,
        "Browser Hardware / Promote Trusted Artifact",
        "completed",
        "success",
      );
      const authorizationJob = uniqueJob(
        jobs.jobs,
        "Browser Hardware / Authorize JIT Runner",
        "in_progress",
      );
      const queuedJob = hardwareMatches[0];
      const platformLabels = queuedJob.labels.filter(
        (label) => !promotion.customLabels.includes(label),
      );
      return createRunnerAuthorization({
        promotion,
        queuedJob,
        workflow: { sha: promotion.workflowSha },
        run: { id: Number(runId), attempt: Number(runAttempt) },
        promotionJobId: promotionJob.id,
        authorizationJobId: authorizationJob.id,
        platformLabels,
        issuedAt: now(),
        policy,
      });
    }
    if (now().getTime() - startedAt >= timeoutMs) {
      throw new Error("timed out waiting for exactly one queued hardware job");
    }
    await delayImpl(5_000);
  }
}

function uniqueJob(jobs, name, status, conclusion = undefined) {
  const matches = jobs.filter(
    (job) =>
      job.name === name &&
      job.status === status &&
      (conclusion === undefined || job.conclusion === conclusion),
  );
  if (matches.length !== 1) {
    throw new Error(`expected exactly one ${name} job in ${status}`);
  }
  return matches[0];
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
    throw new Error(`GitHub jobs API failed with HTTP ${response.status}`);
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
  const promotion = JSON.parse(readFileSync(args.get("--promotion"), "utf8"));
  const policy = JSON.parse(readFileSync(args.get("--browser-policy"), "utf8"));
  const authorization = await pollAndAuthorize({
    apiBase: process.env.GITHUB_API_URL,
    repository: process.env.GITHUB_REPOSITORY,
    token: process.env.GITHUB_TOKEN,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    promotion,
    policy,
  });
  writeFileSync(args.get("--output"), `${authorization.canonical}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(
      process.env.GITHUB_OUTPUT,
      `authorization-sha256=${authorization.sha256}\n`,
      { encoding: "utf8", flag: "a" },
    );
  }
  console.log(JSON.stringify({ ok: true, sha256: authorization.sha256 }));
}
