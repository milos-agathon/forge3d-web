import assert from "node:assert/strict";
import test from "node:test";

import { resolveImplementationActors } from "../../scripts/resolve-implementation-actors.mjs";

const targetSha = "a".repeat(40);

test("implementation actors include direct authors/committers and merged PR authors", async () => {
  const responses = [
    [],
    {
      status: "ahead",
      commits: [
        {
          sha: "b".repeat(40),
          author: { login: "direct-author" },
          committer: { login: "direct-committer" },
        },
      ],
    },
    [
      {
        merged_at: "2026-07-29T10:00:00Z",
        base: { ref: "main" },
        user: { login: "pr-author" },
      },
    ],
  ];
  const result = await resolveImplementationActors({
    targetSha,
    token: "test",
    fetchImpl: async () => response(responses.shift()),
  });
  assert.deepEqual(result.actors, [
    "direct-author",
    "direct-committer",
    "pr-author",
  ]);
  assert.equal(result.base, "ffba491");
});

test("unresolved GitHub author or committer identity fails closed", async () => {
  const responses = [
    [],
    {
      status: "ahead",
      commits: [
        {
          sha: "b".repeat(40),
          author: null,
          committer: { login: "committer" },
        },
      ],
    },
  ];
  await assert.rejects(
    () =>
      resolveImplementationActors({
        targetSha,
        token: "test",
        fetchImpl: async () => response(responses.shift()),
      }),
    /unresolved direct commit author/u,
  );
});

test("latest immutable SemVer release replaces the first-release baseline", async () => {
  const responses = [
    [
      {
        draft: false,
        prerelease: false,
        immutable: true,
        tag_name: "v1.25.0",
      },
    ],
    { status: "identical", commits: [] },
  ];
  const result = await resolveImplementationActors({
    targetSha,
    token: "test",
    fetchImpl: async () => response(responses.shift()),
  });
  assert.equal(result.base, "v1.25.0");
});

test("unmerged or non-main pull requests do not enter the implementation set", async () => {
  const responses = [
    [],
    {
      status: "ahead",
      commits: [
        {
          sha: "b".repeat(40),
          author: { login: "author" },
          committer: { login: "committer" },
        },
      ],
    },
    [
      { merged_at: null, base: { ref: "main" }, user: { login: "unmerged" } },
      {
        merged_at: "2026-07-29T10:00:00Z",
        base: { ref: "feature" },
        user: { login: "wrong-base" },
      },
    ],
  ];
  const result = await resolveImplementationActors({
    targetSha,
    token: "test",
    fetchImpl: async () => response(responses.shift()),
  });
  assert.deepEqual(result.actors, ["author", "committer"]);
});

function response(json, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => structuredClone(json),
  };
}
