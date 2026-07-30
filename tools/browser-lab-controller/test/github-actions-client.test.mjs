import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ControllerGitHubTokenProvider } from "../src/github-actions-client.mjs";

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

function response(status, value) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => value,
  };
}
