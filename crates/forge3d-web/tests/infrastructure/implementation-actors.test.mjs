import assert from "node:assert/strict";
import test from "node:test";

import { resolveImplementationActors } from "../../scripts/resolve-implementation-actors.mjs";

const apiBase = "https://api.github.com";
const repository = "milos-agathon/forge3d-web";
const targetSha = "a".repeat(40);

test("implementation actors include direct authors/committers and every associated merged PR author", async () => {
  const responses = [
    [],
    comparison([
      commit(targetSha, "direct-author", "direct-committer"),
    ]),
    [
      {
        merged_at: "2026-07-29T10:00:00Z",
        base: { ref: "feature" },
        user: { login: "pr-author" },
      },
      { merged_at: null, base: { ref: "main" }, user: null },
    ],
  ];
  const result = await resolveImplementationActors({
    targetSha,
    token: "test",
    fetchImpl: queueFetch(responses),
  });
  assert.deepEqual(result.actors, [
    "direct-author",
    "direct-committer",
    "pr-author",
  ]);
  assert.equal(result.base, "ffba491");
});

test("unresolved direct or merged-PR GitHub identities fail closed", async () => {
  await assert.rejects(
    () =>
      resolveImplementationActors({
        targetSha,
        token: "test",
        fetchImpl: queueFetch([
          [],
          comparison([commit(targetSha, null, "committer")]),
        ]),
      }),
    /unresolved direct commit author/u,
  );
  await assert.rejects(
    () =>
      resolveImplementationActors({
        targetSha,
        token: "test",
        fetchImpl: queueFetch([
          [],
          comparison([commit(targetSha, "author", "committer")]),
          [{ merged_at: "2026-07-29T10:00:00Z", user: null }],
        ]),
      }),
    /unresolved merged pull-request author/u,
  );
});

test("resolver paginates all releases and selects only a published immutable stable SemVer", async () => {
  const releasePage2 = `${apiBase}/repos/${repository}/releases?per_page=100&page=2`;
  const requested = [];
  const result = await resolveImplementationActors({
    targetSha,
    token: "test",
    fetchImpl: queueFetch(
      [
        response(
          [
            release("v1.27.0", { immutable: false }),
            release("v1.26.0-rc.1"),
          ],
          { link: `<${releasePage2}>; rel="next"` },
        ),
        [release("v1.25.0")],
        { status: "identical", total_commits: 0, commits: [] },
      ],
      requested,
    ),
  });
  assert.equal(result.base, "v1.25.0");
  assert.equal(requested.includes(releasePage2), true);
});

test("resolver paginates the complete comparison and every commit PR list", async () => {
  const firstSha = "b".repeat(40);
  const comparePage2 = `${apiBase}/repos/${repository}/compare/ffba491...${targetSha}?per_page=100&page=2`;
  const pullsPage2 = `${apiBase}/repos/${repository}/commits/${firstSha}/pulls?per_page=100&page=2`;
  const result = await resolveImplementationActors({
    targetSha,
    token: "test",
    fetchImpl: queueFetch([
      [],
      response(
        {
          status: "ahead",
          total_commits: 2,
          commits: [commit(firstSha, "author-one", "committer-one")],
        },
        { link: `<${comparePage2}>; rel="next"` },
      ),
      {
        status: "ahead",
        total_commits: 2,
        commits: [commit(targetSha, "author-two", "committer-two")],
      },
      response(
        [
          {
            merged_at: "2026-07-29T10:00:00Z",
            user: { login: "pr-one" },
          },
        ],
        { link: `<${pullsPage2}>; rel="next"` },
      ),
      [
        {
          merged_at: "2026-07-29T10:01:00Z",
          user: { login: "pr-two" },
        },
      ],
      [],
    ]),
  });
  assert.deepEqual(result.actors, [
    "author-one",
    "author-two",
    "committer-one",
    "committer-two",
    "pr-one",
    "pr-two",
  ]);
});

test("truncated, inconsistent, duplicated, or unresolved comparison pages fail closed", async () => {
  const comparePage2 = `${apiBase}/repos/${repository}/compare/ffba491...${targetSha}?per_page=100&page=2`;
  const cases = [
    [
      [[], { status: "ahead", total_commits: 2, commits: [commit(targetSha)] }],
      /pagination is incomplete/u,
    ],
    [
      [
        [],
        response(
          { status: "ahead", total_commits: 2, commits: [commit("b".repeat(40))] },
          { link: `<${comparePage2}>; rel="next"` },
        ),
        { status: "ahead", total_commits: 3, commits: [commit(targetSha)] },
      ],
      /metadata changed/u,
    ],
    [
      [
        [],
        response(
          { status: "ahead", total_commits: 2, commits: [commit(targetSha)] },
          { link: `<${comparePage2}>; rel="next"` },
        ),
        { status: "ahead", total_commits: 2, commits: [commit(targetSha)] },
      ],
      /invalid or duplicated/u,
    ],
  ];
  for (const [responses, expected] of cases) {
    await assert.rejects(
      () =>
        resolveImplementationActors({
          targetSha,
          token: "test",
          fetchImpl: queueFetch(responses),
        }),
      expected,
    );
  }
});

test("pagination rejects cycles and next links outside the repository API", async () => {
  const releases = `${apiBase}/repos/${repository}/releases?per_page=100`;
  for (const link of [releases, "https://example.invalid/steal"]) {
    await assert.rejects(
      () =>
        resolveImplementationActors({
          targetSha,
          token: "test",
          fetchImpl: queueFetch([
            response([], { link: `<${link}>; rel="next"` }),
          ]),
        }),
      /cycle|left the exact repository endpoint/u,
    );
  }
});

function comparison(commits) {
  return { status: commits.length === 0 ? "identical" : "ahead", total_commits: commits.length, commits };
}

function commit(sha, author = "author", committer = "committer") {
  return {
    sha,
    author: author === null ? null : { login: author },
    committer: committer === null ? null : { login: committer },
  };
}

function release(tagName, overrides = {}) {
  return {
    draft: false,
    prerelease: false,
    immutable: true,
    published_at: "2026-07-29T09:00:00Z",
    tag_name: tagName,
    ...overrides,
  };
}

function queueFetch(values, requested = []) {
  const queue = [...values];
  return async (url) => {
    requested.push(url);
    assert.ok(queue.length > 0, `unexpected request: ${url}`);
    const value = queue.shift();
    return value?.ok === undefined ? response(value) : value;
  };
}

function response(json, { status = 200, link = null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return name.toLowerCase() === "link" ? link : null;
      },
    },
    json: async () => structuredClone(json),
  };
}
