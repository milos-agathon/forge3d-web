import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

test("every observer workflow separates App administration/actions reads from job-token check runs", () => {
  const workflowRoot = resolve(import.meta.dirname, "../../../../.github/workflows");
  const workflowNames = [
    "browser-hardware-release-readiness.yml",
    "browser-hardware.yml",
    "browser-lab-broker.yml",
    "browser-lab-controller.yml",
    "browser-lab-infrastructure-readiness.yml",
    "browser-package.yml",
    "prepare-browser-manual-evidence.yml",
    "publish-browser-lab-canary.yml",
    "publish-web-release.yml",
    "submit-browser-manual-evidence.yml",
  ];
  for (const name of workflowNames) {
    const source = readFileSync(resolve(workflowRoot, name), "utf8");
    const verification = source.slice(
      source.lastIndexOf("      - name:", source.indexOf("verify-repository-trust.mjs")),
      source.indexOf("      - name:", source.indexOf("verify-repository-trust.mjs") + 1),
    );
    assert.match(
      verification,
      /TRUST_OBSERVER_TOKEN: \$\{\{ steps\.observer-token\.outputs\.token \}\}/u,
      name,
    );
    assert.match(
      verification,
      /GITHUB_TOKEN: \$\{\{ github\.token \}\}/u,
      name,
    );
    assert.equal(
      verification.includes("GITHUB_TOKEN: ${{ steps.observer-token.outputs.token }}"),
      false,
      name,
    );
  }
});

test("manual-submission draft lookup uses only the workflow job token", () => {
  const source = readFileSync(
    resolve(
      import.meta.dirname,
      "../../../../.github/workflows/submit-browser-manual-evidence.yml",
    ),
    "utf8",
  );
  const step = source.slice(
    source.indexOf("      - name: Verify live trust and derive exact intake target"),
    source.indexOf("      - name: Emit target-bound submission observation"),
  );
  assert.match(step, /Authorization: `Bearer \$\{process\.env\.GITHUB_TOKEN\}`/u);
  assert.equal(step.includes("process.env.TRUST_OBSERVER_TOKEN"), false);
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
