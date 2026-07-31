import { createHash, createSign } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import { extractZipEntries } from "./zip-artifact.mjs";

const REPOSITORY = Object.freeze({
  id: 1259761852,
  fullName: "milos-agathon/forge3d-web",
});

export class ControllerGitHubTokenProvider {
  constructor({
    appId,
    installationId,
    privateKeyPath,
    apiBase = "https://api.github.com",
    fetchImpl = fetch,
    now = () => new Date(),
  }) {
    this.appId = String(appId);
    this.installationId = String(installationId);
    this.privateKeyPath = privateKeyPath;
    this.apiBase = apiBase;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.cached = null;
  }

  async getToken() {
    if (
      this.cached &&
      Date.parse(this.cached.expiresAt) - this.now().getTime() > 60_000
    ) {
      return this.cached.token;
    }
    if (!/^\d+$/u.test(this.appId) || !/^\d+$/u.test(this.installationId)) {
      throw new Error("controller GitHub App IDs must be decimal values");
    }
    const issuedAt = Math.floor(this.now().getTime() / 1000) - 30;
    const header = base64Url({ alg: "RS256", typ: "JWT" });
    const payload = base64Url({
      iat: issuedAt,
      exp: issuedAt + 9 * 60,
      iss: this.appId,
    });
    const input = `${header}.${payload}`;
    const jwt = `${input}.${createSign("RSA-SHA256")
      .update(input)
      .end()
      .sign(readFileSync(this.privateKeyPath, "utf8"), "base64url")}`;
    const response = await this.fetchImpl(
      `${this.apiBase}/app/installations/${this.installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          ...githubHeaders(jwt),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          repository_ids: [REPOSITORY.id],
          permissions: {
            actions: "read",
            attestations: "read",
            metadata: "read",
          },
        }),
      },
    );
    if (response.status !== 201) {
      throw new Error(
        `controller installation-token request failed with HTTP ${response.status}`,
      );
    }
    const value = await response.json();
    if (
      typeof value.token !== "string" ||
      value.token.length < 20 ||
      value.repository_selection !== "selected" ||
      value.permissions?.actions !== "read" ||
      value.permissions?.attestations !== "read" ||
      value.permissions?.metadata !== "read" ||
      Object.keys(value.permissions).some(
        (name) => !["actions", "attestations", "metadata"].includes(name),
      )
    ) {
      throw new Error("controller App token has missing or excess permissions");
    }
    const repositories = await apiJson(
      `${this.apiBase}/installation/repositories?per_page=100`,
      value.token,
      this.fetchImpl,
    );
    if (
      repositories.total_count !== 1 ||
      repositories.repositories?.length !== 1 ||
      repositories.repositories[0].id !== REPOSITORY.id ||
      repositories.repositories[0].full_name !== REPOSITORY.fullName
    ) {
      throw new Error("controller App token is not scoped to the fixed repository");
    }
    this.cached = { token: value.token, expiresAt: value.expires_at };
    return value.token;
  }
}

export class ControllerGitHubActionsClient {
  constructor({
    tokenProvider,
    apiBase = "https://api.github.com",
    fetchImpl = fetch,
    attestationCommand = "gh",
  }) {
    this.tokenProvider = tokenProvider;
    this.apiBase = apiBase;
    this.fetchImpl = fetchImpl;
    this.attestationCommand = attestationCommand;
    this.repositoryPath = `/repos/${REPOSITORY.fullName}`;
  }

  async listCandidateRuns() {
    const values = await Promise.all(
      ["queued", "in_progress"].map((status) =>
        this.requestJson(
          `${this.repositoryPath}/actions/workflows/browser-hardware.yml/runs?event=workflow_dispatch&status=${status}&per_page=100`,
        ),
      ),
    );
    const unique = new Map();
    for (const run of values.flatMap((value) => value.workflow_runs ?? [])) {
      if (
        run.path === ".github/workflows/browser-hardware.yml" &&
        run.head_branch === "main" &&
        run.event === "workflow_dispatch" &&
        Number.isInteger(run.id) &&
        run.id > 0 &&
        Number.isInteger(run.run_attempt) &&
        run.run_attempt > 0 &&
        /^[0-9a-f]{40}$/u.test(run.head_sha ?? "")
      ) {
        unique.set(`${run.id}:${run.run_attempt}`, {
          id: run.id,
          attempt: run.run_attempt,
          workflowSha: run.head_sha,
        });
      }
    }
    return [...unique.values()];
  }

  async listRunAttemptJobs(runId, runAttempt) {
    const value = await this.requestJson(
      `${this.repositoryPath}/actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100`,
    );
    return value.jobs ?? [];
  }

  getJob(jobId) {
    return this.requestJson(
      `${this.repositoryPath}/actions/jobs/${jobId}`,
    );
  }

  async listRunArtifacts(runId) {
    const value = await this.requestJson(
      `${this.repositoryPath}/actions/runs/${runId}/artifacts?per_page=100`,
    );
    return (value.artifacts ?? []).map((artifact) => ({
      id: artifact.id,
      name: artifact.name,
      expired: artifact.expired,
      workflowRunId: artifact.workflow_run?.id,
      digest: artifact.digest,
    }));
  }

  async downloadArtifactById(id) {
    const token = await this.tokenProvider.getToken();
    const response = await this.fetchImpl(
      `${this.apiBase}${this.repositoryPath}/actions/artifacts/${id}/zip`,
      {
        headers: githubHeaders(token),
        redirect: "follow",
      },
    );
    if (!response.ok) {
      throw new Error(`authorization artifact download failed with HTTP ${response.status}`);
    }
    const archiveBytes = Buffer.from(await response.arrayBuffer());
    const archiveDigest = `sha256:${sha256(archiveBytes)}`;
    return {
      archiveBytes,
      archiveDigest,
      files: extractZipEntries(archiveBytes),
    };
  }

  async verifyAttestation({
    bytes,
    repository,
    signerWorkflow,
    sourceRef,
    sourceDigest,
    denySelfHostedRunners,
  }) {
    if (
      repository !== REPOSITORY.fullName ||
      denySelfHostedRunners !== true
    ) {
      throw new Error("controller attestation policy is invalid");
    }
    const directory = mkdtempSync(join(tmpdir(), "forge3d-controller-attest-"));
    const subject = join(directory, "runner-authorization.json");
    try {
      writeFileSync(subject, bytes, { mode: 0o600 });
      const token = await this.tokenProvider.getToken();
      const result = spawnSync(
        this.attestationCommand,
        [
          "attestation",
          "verify",
          subject,
          "--repo",
          repository,
          "--signer-workflow",
          signerWorkflow,
          "--source-ref",
          sourceRef,
          "--source-digest",
          sourceDigest,
          "--deny-self-hosted-runners",
        ],
        {
          encoding: "utf8",
          env: { ...process.env, GH_TOKEN: token },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      if (result.status !== 0) {
        throw new Error(
          `authorization attestation verification failed: ${result.stderr.trim()}`,
        );
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  async requestJson(path) {
    const token = await this.tokenProvider.getToken();
    return apiJson(`${this.apiBase}${path}`, token, this.fetchImpl);
  }
}

async function apiJson(url, token, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: githubHeaders(token),
  });
  if (!response.ok) {
    throw new Error(`GitHub API request failed with HTTP ${response.status}`);
  }
  return response.json();
}

function githubHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function base64Url(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
