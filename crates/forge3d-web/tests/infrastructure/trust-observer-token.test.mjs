import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { mintGitHubAppInstallationToken } from "../../scripts/mint-github-app-token.mjs";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const privateKeyPem = privateKey.export({
  type: "pkcs8",
  format: "pem",
});

test("accepts only the exact read-only observer permissions and repository", async () => {
  const result = await mintGitHubAppInstallationToken({
    appId: "1",
    installationId: "2",
    privateKey: privateKeyPem,
    fetchImpl: async (url, options) => {
      if (url.includes("/access_tokens")) {
        assert.match(
          options.headers.Authorization,
          /^Bearer [^.]+\.[^.]+\.[^.]+$/u,
        );
        return response(makeBody(), 201);
      }
      assert.equal(
        options.headers.Authorization,
        "Bearer observer-installation-token",
      );
      return response(makeRepositories(), 200);
    },
    now: Date.parse("2026-07-28T12:00:00.000Z"),
  });
  assert.equal(result.token, "observer-installation-token");
  assert.equal(result.repositorySelection, "selected");
});

test("rejects an observer App with write or excess permissions", async () => {
  const body = makeBody();
  body.permissions.contents = "read";
  await assert.rejects(
    mintGitHubAppInstallationToken({
      appId: "1",
      installationId: "2",
      privateKey: privateKeyPem,
      fetchImpl: async () => response(body, 201),
    }),
    /missing or excess permissions/u,
  );
});

test("rejects an observer installation with another repository", async () => {
  await assert.rejects(
    mintGitHubAppInstallationToken({
      appId: "1",
      installationId: "2",
      privateKey: privateKeyPem,
      fetchImpl: async (url) =>
        url.includes("/access_tokens")
          ? response(makeBody(), 201)
          : response(
              {
                total_count: 1,
                repositories: [{ id: 1, full_name: "other/repository" }],
              },
              200,
            ),
    }),
    /canonical repository/u,
  );
});

function makeBody() {
  return {
    token: "observer-installation-token",
    expires_at: "2026-07-28T12:10:00.000Z",
    repository_selection: "selected",
    permissions: {
      actions: "read",
      administration: "read",
      attestations: "read",
      metadata: "read",
    },
  };
}

function makeRepositories() {
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
