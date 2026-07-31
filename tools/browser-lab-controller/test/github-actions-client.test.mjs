import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ControllerGitHubActionsClient,
  ControllerGitHubTokenProvider,
} from "../src/github-actions-client.mjs";

test("controller requests one-repository read-only Actions and Attestations token", async () => {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const directory = mkdtempSync(join(tmpdir(), "forge3d-controller-app-"));
  const privateKeyPath = join(directory, "app.pem");
  writeFileSync(
    privateKeyPath,
    keys.privateKey.export({ format: "pem", type: "pkcs8" }),
    { mode: 0o600 },
  );
  const requests = [];
  const provider = new ControllerGitHubTokenProvider({
    appId: "123",
    installationId: "456",
    privateKeyPath,
    now: () => new Date("2026-07-29T10:00:00.000Z"),
    fetchImpl: async (url, request = {}) => {
      requests.push({ url, request });
      if (url.endsWith("/access_tokens")) {
        return response(201, {
          token: "installation-token-value",
          expires_at: "2026-07-29T11:00:00.000Z",
          repository_selection: "selected",
          permissions: {
            actions: "read",
            attestations: "read",
            metadata: "read",
          },
        });
      }
      return response(200, {
        total_count: 1,
        repositories: [
          {
            id: 1259761852,
            full_name: "milos-agathon/forge3d-web",
          },
        ],
      });
    },
  });
  assert.equal(await provider.getToken(), "installation-token-value");
  const requestBody = JSON.parse(requests[0].request.body);
  assert.deepEqual(requestBody, {
    repository_ids: [1259761852],
    permissions: {
      actions: "read",
      attestations: "read",
      metadata: "read",
    },
  });
});

test("production client maps the exact API run attempt and ignores malformed candidates", async () => {
  const valid = {
    id: 101,
    run_attempt: 2,
    path: ".github/workflows/browser-hardware.yml",
    head_branch: "main",
    head_sha: "a".repeat(40),
    event: "workflow_dispatch",
  };
  const requested = [];
  const client = actionsClient(async (url) => {
    requested.push(url);
    const status = new URL(url).searchParams.get("status");
    return response(200, {
      workflow_runs:
        status === "queued"
          ? [
              valid,
              { ...valid, id: 0 },
              { ...valid, run_attempt: 0 },
              { ...valid, head_sha: "A".repeat(40) },
              { ...valid, event: "push" },
              { ...valid, path: ".github/workflows/other.yml" },
              { ...valid, head_branch: "feature" },
            ]
          : [valid],
    });
  });

  assert.deepEqual(await client.listCandidateRuns(), [
    { id: 101, attempt: 2, workflowSha: "a".repeat(40) },
  ]);
  assert.equal(requested.length, 2);
  assert.ok(requested.every((url) => url.includes("event=workflow_dispatch")));
});

test("production artifact mapper does not use optional workflow run-attempt metadata", async () => {
  const client = actionsClient(async (url) => {
    assert.match(url, /\/actions\/runs\/101\/artifacts\?per_page=100$/u);
    return response(200, {
      artifacts: [
        {
          id: 301,
          name: `runner-authorization-${"ab".repeat(16)}`,
          expired: false,
          digest: `sha256:${"c".repeat(64)}`,
          workflow_run: { id: 101 },
        },
      ],
    });
  });

  assert.deepEqual(await client.listRunArtifacts(101), [
    {
      id: 301,
      name: `runner-authorization-${"ab".repeat(16)}`,
      expired: false,
      workflowRunId: 101,
      digest: `sha256:${"c".repeat(64)}`,
    },
  ]);
});

function actionsClient(fetchImpl) {
  return new ControllerGitHubActionsClient({
    tokenProvider: { getToken: async () => "read-only-installation-token" },
    fetchImpl,
  });
}

function response(status, value) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => value,
  };
}
