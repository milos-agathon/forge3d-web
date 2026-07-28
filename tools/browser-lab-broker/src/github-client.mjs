import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

import { FIXED_REPOSITORY } from "./protocol.mjs";

export class GitHubAppTokenProvider {
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
      throw new Error("broker GitHub App IDs must be decimal values");
    }
    const issuedAt = Math.floor(this.now().getTime() / 1000) - 30;
    const header = base64Url({ alg: "RS256", typ: "JWT" });
    const payload = base64Url({
      iat: issuedAt,
      exp: issuedAt + 9 * 60,
      iss: this.appId,
    });
    const signingInput = `${header}.${payload}`;
    const jwt = `${signingInput}.${createSign("RSA-SHA256")
      .update(signingInput)
      .end()
      .sign(readFileSync(this.privateKeyPath, "utf8"), "base64url")}`;
    const response = await this.fetchImpl(
      `${this.apiBase}/app/installations/${this.installationId}/access_tokens`,
      {
        method: "POST",
        headers: githubHeaders(jwt),
      },
    );
    if (response.status !== 201) {
      throw new Error(`broker installation-token request failed with HTTP ${response.status}`);
    }
    const value = await response.json();
    const expectedPermissions = {
      actions: "write",
      administration: "write",
      metadata: "read",
    };
    if (
      typeof value.token !== "string" ||
      value.token.length < 20 ||
      value.repository_selection !== "selected" ||
      JSON.stringify(sortObject(value.permissions ?? {})) !==
        JSON.stringify(sortObject(expectedPermissions))
    ) {
      throw new Error("broker App token has missing or excess repository permissions");
    }
    const repositoriesResponse = await this.fetchImpl(
      `${this.apiBase}/installation/repositories?per_page=100`,
      { headers: githubHeaders(value.token) },
    );
    if (repositoriesResponse.status !== 200) {
      throw new Error(
        `broker repository-scope request failed with HTTP ${repositoriesResponse.status}`,
      );
    }
    const repositories = await repositoriesResponse.json();
    if (
      repositories.total_count !== 1 ||
      repositories.repositories?.length !== 1 ||
      repositories.repositories[0].id !== FIXED_REPOSITORY.id ||
      repositories.repositories[0].full_name !== FIXED_REPOSITORY.fullName
    ) {
      throw new Error("broker App token is not scoped to the fixed repository");
    }
    this.cached = { token: value.token, expiresAt: value.expires_at };
    return value.token;
  }
}

export class GitHubRepositoryClient {
  constructor({
    tokenProvider,
    apiBase = "https://api.github.com",
    fetchImpl = fetch,
  }) {
    this.tokenProvider = tokenProvider;
    this.apiBase = apiBase;
    this.fetchImpl = fetchImpl;
    this.repositoryPath = `/repos/${FIXED_REPOSITORY.fullName}`;
  }

  async generateJitConfig(body) {
    return this.request(
      "POST",
      `${this.repositoryPath}/actions/runners/generate-jitconfig`,
      body,
      [201],
      true,
    );
  }

  async getRunner(runnerId) {
    const response = await this.request(
      "GET",
      `${this.repositoryPath}/actions/runners/${runnerId}`,
      null,
      [200, 404],
      true,
    );
    return response.status === 404 ? null : response.body;
  }

  async listRunners() {
    return (
      await this.request(
        "GET",
        `${this.repositoryPath}/actions/runners?per_page=100`,
        null,
        [200],
      )
    ).body;
  }

  async deleteRunner(runnerId) {
    await this.request(
      "DELETE",
      `${this.repositoryPath}/actions/runners/${runnerId}`,
      null,
      [204],
    );
  }

  async getJob(jobId) {
    return (
      await this.request(
        "GET",
        `${this.repositoryPath}/actions/jobs/${jobId}`,
        null,
        [200],
      )
    ).body;
  }

  async cancelRun(runId) {
    await this.request(
      "POST",
      `${this.repositoryPath}/actions/runs/${runId}/cancel`,
      null,
      [202],
    );
  }

  async getRun(runId) {
    return (
      await this.request(
        "GET",
        `${this.repositoryPath}/actions/runs/${runId}`,
        null,
        [200],
      )
    ).body;
  }

  async getWorkflowRunsForSha(sha) {
    return (
      await this.request(
        "GET",
        `${this.repositoryPath}/actions/runs?branch=main&head_sha=${sha}&event=push&status=completed&per_page=100`,
        null,
        [200],
      )
    ).body;
  }

  async getRunJobs(runId) {
    return (
      await this.request(
        "GET",
        `${this.repositoryPath}/actions/runs/${runId}/jobs?filter=latest&per_page=100`,
        null,
        [200],
      )
    ).body;
  }

  async getRepository() {
    return (await this.request("GET", this.repositoryPath, null, [200])).body;
  }

  async getBranch(branch) {
    return (
      await this.request(
        "GET",
        `${this.repositoryPath}/branches/${branch}`,
        null,
        [200],
      )
    ).body;
  }

  async getProtection(branch) {
    return (
      await this.request(
        "GET",
        `${this.repositoryPath}/branches/${branch}/protection`,
        null,
        [200],
      )
    ).body;
  }

  async getActionsPermissions() {
    return (
      await this.request(
        "GET",
        `${this.repositoryPath}/actions/permissions`,
        null,
        [200],
      )
    ).body;
  }

  async compareCommits(base, head) {
    return (
      await this.request(
        "GET",
        `${this.repositoryPath}/compare/${base}...${head}`,
        null,
        [200],
      )
    ).body;
  }

  async request(method, path, body, expectedStatuses, includeStatus = false) {
    const token = await this.tokenProvider.getToken();
    const response = await this.fetchImpl(`${this.apiBase}${path}`, {
      method,
      headers: {
        ...githubHeaders(token),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let responseBody = null;
    if (response.status !== 204) {
      const text = await response.text();
      responseBody = text ? JSON.parse(text) : null;
    }
    if (!expectedStatuses.includes(response.status)) {
      throw new Error(
        `GitHub API ${method} ${path} returned HTTP ${response.status}`,
      );
    }
    return includeStatus
      ? { status: response.status, body: responseBody }
      : { status: response.status, body: responseBody };
  }
}

function githubHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function base64Url(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function sortObject(value) {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}
