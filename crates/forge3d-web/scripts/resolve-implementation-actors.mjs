import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const firstReleaseBaseline = "ffba491";
const stableSemVer = /^v?(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;

export async function resolveImplementationActors({
  apiBase = "https://api.github.com",
  repository = "milos-agathon/forge3d-web",
  targetSha,
  token,
  fetchImpl = fetch,
}) {
  if (!/^[0-9a-f]{40}$/u.test(targetSha ?? "")) {
    throw new Error("target SHA must be a full lowercase commit SHA");
  }
  const releases = await apiArrayPages(
    `${apiBase}/repos/${repository}/releases?per_page=100`,
    token,
    fetchImpl,
    apiBase,
    repository,
    "release",
  );
  const previous = releases.find(
    (release) =>
      release.draft === false &&
      release.prerelease === false &&
      release.immutable === true &&
      validTimestamp(release.published_at) &&
      stableSemVer.test(release.tag_name ?? ""),
  );
  const base = previous?.tag_name ?? firstReleaseBaseline;
  if (!/^(?:[0-9a-f]{7,40}|v?[0-9]+\.[0-9]+\.[0-9]+)$/u.test(base)) {
    throw new Error("previous release tag/baseline is invalid");
  }
  const comparison = await completeComparison(
    `${apiBase}/repos/${repository}/compare/${encodeURIComponent(base)}...${targetSha}?per_page=100&page=1`,
    token,
    fetchImpl,
    apiBase,
    repository,
    targetSha,
  );
  const actors = new Set();
  for (const commit of comparison.commits) {
    for (const [role, identity] of [
      ["author", commit.author?.login],
      ["committer", commit.committer?.login],
    ]) {
      if (!validLogin(identity)) {
        throw new Error(`unresolved direct commit ${role}: ${commit.sha}`);
      }
      actors.add(identity);
    }
    const pulls = await apiArrayPages(
      `${apiBase}/repos/${repository}/commits/${commit.sha}/pulls?per_page=100`,
      token,
      fetchImpl,
      apiBase,
      repository,
      `pull request for ${commit.sha}`,
    );
    for (const pull of pulls) {
      if (!pull.merged_at) continue;
      if (!validTimestamp(pull.merged_at) || !validLogin(pull.user?.login)) {
        throw new Error(`unresolved merged pull-request author: ${commit.sha}`);
      }
      actors.add(pull.user.login);
    }
  }
  if (actors.size === 0 && comparison.status !== "identical") {
    throw new Error("implementation actor set unexpectedly resolved empty");
  }
  return {
    schemaVersion: 1,
    repository,
    base,
    targetSha,
    actors: [...actors].sort(),
  };
}

async function apiArrayPages(
  url,
  token,
  fetchImpl,
  apiBase,
  repository,
  label,
) {
  const values = [];
  const visited = new Set();
  let next = url;
  while (next !== null) {
    if (visited.has(next)) throw new Error(`${label} pagination contains a cycle`);
    visited.add(next);
    const page = await apiPage(next, token, fetchImpl);
    if (!Array.isArray(page.body)) {
      throw new Error(`${label} API page must be an array`);
    }
    values.push(...page.body);
    next = nextPageUrl(page.response, next, apiBase, repository);
  }
  return values;
}

async function completeComparison(
  url,
  token,
  fetchImpl,
  apiBase,
  repository,
  targetSha,
) {
  const commits = [];
  const seenShas = new Set();
  const visited = new Set();
  let expectedStatus = null;
  let expectedTotal = null;
  let next = url;
  while (next !== null) {
    if (visited.has(next)) throw new Error("comparison pagination contains a cycle");
    visited.add(next);
    const page = await apiPage(next, token, fetchImpl);
    const value = page.body;
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !["ahead", "identical"].includes(value.status) ||
      !Number.isInteger(value.total_commits) ||
      value.total_commits < 0 ||
      !Array.isArray(value.commits)
    ) {
      throw new Error("target is not a comparable descendant of the release baseline");
    }
    expectedStatus ??= value.status;
    expectedTotal ??= value.total_commits;
    if (value.status !== expectedStatus || value.total_commits !== expectedTotal) {
      throw new Error("comparison pagination metadata changed between pages");
    }
    for (const commit of value.commits) {
      if (!/^[0-9a-f]{40}$/u.test(commit?.sha ?? "") || seenShas.has(commit.sha)) {
        throw new Error("comparison commit inventory is invalid or duplicated");
      }
      seenShas.add(commit.sha);
      commits.push(commit);
    }
    next = nextPageUrl(page.response, next, apiBase, repository);
  }
  if (
    commits.length !== expectedTotal ||
    (expectedStatus === "identical" && expectedTotal !== 0) ||
    (expectedStatus === "ahead" &&
      (expectedTotal === 0 || commits.at(-1)?.sha !== targetSha))
  ) {
    throw new Error("comparison commit pagination is incomplete");
  }
  return { status: expectedStatus, totalCommits: expectedTotal, commits };
}

async function apiPage(url, token, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub identity API failed with HTTP ${response.status}`);
  }
  return { body: await response.json(), response };
}

function nextPageUrl(response, currentUrl, apiBase, repository) {
  const link = response.headers?.get?.("link");
  if (link === undefined || link === null || link.trim() === "") return null;
  const matches = [...link.matchAll(/<([^>]+)>;\s*rel="next"/gu)];
  if (matches.length === 0) return null;
  if (matches.length !== 1) throw new Error("GitHub pagination has multiple next links");
  const next = new URL(matches[0][1], currentUrl);
  const current = new URL(currentUrl);
  const allowed = new URL(apiBase);
  const repositoryPath = `${allowed.pathname.replace(/\/$/u, "")}/repos/${repository}/`;
  const currentPage = Number(current.searchParams.get("page") ?? "1");
  const nextPage = Number(next.searchParams.get("page"));
  if (
    next.origin !== allowed.origin ||
    !next.pathname.startsWith(repositoryPath) ||
    next.pathname !== current.pathname ||
    next.searchParams.get("per_page") !== "100" ||
    !Number.isInteger(nextPage) ||
    nextPage <= currentPage
  ) {
    throw new Error("GitHub pagination next link left the exact repository endpoint");
  }
  return next.href;
}

function validLogin(value) {
  return typeof value === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(value);
}

function validTimestamp(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
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
  const result = await resolveImplementationActors({
    apiBase: process.env.GITHUB_API_URL,
    repository: process.env.GITHUB_REPOSITORY,
    targetSha: args.get("--target-sha"),
    token: process.env.GITHUB_TOKEN,
  });
  writeFileSync(args.get("--output"), `${JSON.stringify(result, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(JSON.stringify({ ok: true, actorCount: result.actors.length }));
}
