import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  GitHubAppTokenProvider,
  GitHubRepositoryClient,
} from "../src/github-client.mjs";

test("broker token is exact-permission and single-repository scoped", async () => {
  const fixture = createFixture();
  try {
    const calls = [];
    const provider = new GitHubAppTokenProvider({
      appId: "1",
      installationId: "2",
      privateKeyPath: fixture.privateKeyPath,
      fetchImpl: async (url, options) => {
        calls.push(url);
        if (url.includes("/access_tokens")) {
          assert.match(
            options.headers.Authorization,
            /^Bearer [^.]+\.[^.]+\.[^.]+$/u,
          );
          assert.deepEqual(JSON.parse(options.body), {
            repository_ids: [1259761852],
            permissions: {
              actions: "write",
              administration: "write",
              checks: "read",
              metadata: "read",
            },
          });
          return response(tokenBody(), 201);
        }
        assert.equal(
          options.headers.Authorization,
          "Bearer broker-installation-token",
        );
        return response(repositoryBody(), 200);
      },
      now: () => new Date("2026-07-28T12:00:00.000Z"),
    });
    assert.equal(await provider.getToken(), "broker-installation-token");
    assert.equal(await provider.getToken(), "broker-installation-token");
    assert.equal(calls.length, 2, "unexpired token should be cached in memory");
  } finally {
    fixture.cleanup();
  }
});

test("broker token rejects excess permission and repository scope", async () => {
  const fixture = createFixture();
  try {
    const excess = tokenBody();
    excess.permissions.contents = "read";
    const excessProvider = new GitHubAppTokenProvider({
      appId: "1",
      installationId: "2",
      privateKeyPath: fixture.privateKeyPath,
      fetchImpl: async () => response(excess, 201),
    });
    await assert.rejects(excessProvider.getToken(), /missing or excess/u);

    const wrongRepository = new GitHubAppTokenProvider({
      appId: "1",
      installationId: "2",
      privateKeyPath: fixture.privateKeyPath,
      fetchImpl: async (url) =>
        url.includes("/access_tokens")
          ? response(tokenBody(), 201)
          : response(
              {
                total_count: 1,
                repositories: [{ id: 1, full_name: "other/repository" }],
              },
              200,
            ),
    });
    await assert.rejects(wrongRepository.getToken(), /fixed repository/u);
  } finally {
    fixture.cleanup();
  }
});

test("runner reconciliation lists the fixed repository and deletes only one exact numeric ID", async () => {
  const calls = [];
  const client = new GitHubRepositoryClient({
    tokenProvider: {
      async getToken() {
        return "broker-installation-token";
      },
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method, body: options.body });
      if (options.method === "GET") {
        return textResponse(
          {
            total_count: 1,
            runners: [{ id: 1001, name: "exact-runner", labels: [] }],
          },
          200,
        );
      }
      assert.equal(options.method, "DELETE");
      return textResponse(null, 204);
    },
  });

  const listing = await client.listRunners();
  assert.equal(listing.total_count, 1);
  await client.deleteRunner(1001);
  await assert.rejects(
    client.deleteRunner("*"),
    /one exact positive integer ID/u,
  );
  await assert.rejects(
    client.deleteRunner(0),
    /one exact positive integer ID/u,
  );
  assert.deepEqual(calls, [
    {
      url: "https://api.github.com/repos/milos-agathon/forge3d-web/actions/runners?per_page=100",
      method: "GET",
      body: undefined,
    },
    {
      url: "https://api.github.com/repos/milos-agathon/forge3d-web/actions/runners/1001",
      method: "DELETE",
      body: undefined,
    },
  ]);
  assert.equal(
    calls.some(({ url }) =>
      /registration-token|remove-token|labels|actions\/runners\/\*/u.test(url),
    ),
    false,
  );
});

test("repository trust fetches all check runs for one exact commit SHA", async () => {
  const sha = "f".repeat(40);
  const calls = [];
  const client = new GitHubRepositoryClient({
    tokenProvider: {
      async getToken() {
        return "broker-installation-token";
      },
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method });
      return textResponse({ total_count: 0, check_runs: [] }, 200);
    },
  });

  assert.deepEqual(await client.getCheckRunsForSha(sha), {
    total_count: 0,
    check_runs: [],
  });
  await assert.rejects(
    client.getCheckRunsForSha("not-a-sha"),
    /one exact lowercase SHA/u,
  );
  assert.deepEqual(calls, [
    {
      url:
        "https://api.github.com/repos/milos-agathon/forge3d-web" +
        `/commits/${sha}/check-runs?filter=all&per_page=100`,
      method: "GET",
    },
  ]);
});

function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), "forge3d-broker-key-"));
  const path = join(directory, "broker.pem");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  writeFileSync(
    path,
    privateKey.export({ type: "pkcs8", format: "pem" }),
    { mode: 0o600 },
  );
  return {
    privateKeyPath: path,
    cleanup() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function tokenBody() {
  return {
    token: "broker-installation-token",
    expires_at: "2026-07-28T12:10:00.000Z",
    repository_selection: "selected",
    permissions: {
      actions: "write",
      administration: "write",
      checks: "read",
      metadata: "read",
    },
  };
}

function repositoryBody() {
  return {
    total_count: 1,
    repositories: [
      {
        id: 1259761852,
        full_name: "milos-agathon/forge3d-web",
      },
    ],
  };
}

function response(body, status) {
  return {
    status,
    async json() {
      return structuredClone(body);
    },
  };
}

function textResponse(body, status) {
  return {
    status,
    async text() {
      return body === null ? "" : JSON.stringify(body);
    },
  };
}
