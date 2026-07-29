import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const firstReleaseBaseline = "ffba491";

export async function resolveImplementationActors({
  apiBase = "https://api.github.com",
  repository = "milos-agathon/forge3d-web",
  targetSha,
  previousTag = null,
  token,
  fetchImpl = fetch,
}) {
  if (!/^[0-9a-f]{40}$/u.test(targetSha ?? "")) {
    throw new Error("target SHA must be a full lowercase commit SHA");
  }
  let base = previousTag;
  if (base === null) {
    const releases = await apiJson(
      `${apiBase}/repos/${repository}/releases?per_page=100`,
      token,
      fetchImpl,
    );
    const previous = releases.find(
      (release) =>
        release.draft === false &&
        release.prerelease === false &&
        release.immutable === true &&
        /^v?[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(
          release.tag_name ?? "",
        ),
    );
    base = previous?.tag_name ?? firstReleaseBaseline;
  }
  if (!/^(?:[0-9a-f]{7,40}|v?[0-9]+\.[0-9]+\.[0-9]+)$/u.test(base)) {
    throw new Error("previous release tag/baseline is invalid");
  }
  const comparison = await apiJson(
    `${apiBase}/repos/${repository}/compare/${encodeURIComponent(base)}...${targetSha}`,
    token,
    fetchImpl,
  );
  if (
    !["ahead", "identical"].includes(comparison.status) ||
    !Array.isArray(comparison.commits)
  ) {
    throw new Error("target is not a comparable descendant of the release baseline");
  }
  const actors = new Set();
  for (const commit of comparison.commits) {
    for (const [role, identity] of [
      ["author", commit.author?.login],
      ["committer", commit.committer?.login],
    ]) {
      if (!identity) {
        throw new Error(`unresolved direct commit ${role}: ${commit.sha}`);
      }
      actors.add(identity);
    }
    const pulls = await apiJson(
      `${apiBase}/repos/${repository}/commits/${commit.sha}/pulls`,
      token,
      fetchImpl,
      "application/vnd.github+json",
    );
    for (const pull of pulls) {
      if (!pull.merged_at || pull.base?.ref !== "main" || !pull.user?.login) {
        continue;
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

async function apiJson(
  url,
  token,
  fetchImpl,
  accept = "application/vnd.github+json",
) {
  const response = await fetchImpl(url, {
    headers: {
      Accept: accept,
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub identity API failed with HTTP ${response.status}`);
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
  const result = await resolveImplementationActors({
    apiBase: process.env.GITHUB_API_URL,
    repository: process.env.GITHUB_REPOSITORY,
    targetSha: args.get("--target-sha"),
    previousTag: args.get("--previous-tag") || null,
    token: process.env.GITHUB_TOKEN,
  });
  writeFileSync(args.get("--output"), `${JSON.stringify(result, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(JSON.stringify({ ok: true, actorCount: result.actors.length }));
}
