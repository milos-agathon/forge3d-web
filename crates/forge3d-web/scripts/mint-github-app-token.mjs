import { createSign } from "node:crypto";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function mintGitHubAppInstallationToken({
  appId,
  installationId,
  privateKey,
  apiBase = process.env.GITHUB_API_URL ?? "https://api.github.com",
  fetchImpl = fetch,
  now = Date.now(),
}) {
  if (!/^\d+$/u.test(String(appId)) || !/^\d+$/u.test(String(installationId))) {
    throw new Error("GitHub App and installation IDs must be positive decimal values");
  }
  if (!privateKey?.includes("PRIVATE KEY")) {
    throw new Error("GitHub App private key is missing or invalid");
  }
  const issuedAt = Math.floor(now / 1000) - 30;
  const header = base64Url({ alg: "RS256", typ: "JWT" });
  const payload = base64Url({
    iat: issuedAt,
    exp: issuedAt + 9 * 60,
    iss: String(appId),
  });
  const signingInput = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256")
    .update(signingInput)
    .end()
    .sign(privateKey, "base64url");
  const response = await fetchImpl(
    `${apiBase}/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${signingInput}.${signature}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (response.status !== 201) {
    throw new Error(`GitHub App token request failed with HTTP ${response.status}`);
  }
  const body = await response.json();
  if (typeof body.token !== "string" || body.token.length < 20) {
    throw new Error("GitHub App token response did not contain a token");
  }
  const expectedPermissions = {
    actions: "read",
    administration: "read",
    attestations: "read",
    metadata: "read",
  };
  if (
    JSON.stringify(sortObject(body.permissions ?? {})) !==
    JSON.stringify(sortObject(expectedPermissions))
  ) {
    throw new Error("trust-observer token has missing or excess permissions");
  }
  if (body.repository_selection !== "selected") {
    throw new Error("trust-observer installation must use selected repositories");
  }
  const repositoriesResponse = await fetchImpl(
    `${apiBase}/installation/repositories?per_page=100`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${body.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (repositoriesResponse.status !== 200) {
    throw new Error(
      `trust-observer repository-scope request failed with HTTP ${repositoriesResponse.status}`,
    );
  }
  const repositories = await repositoriesResponse.json();
  if (
    repositories.total_count !== 1 ||
    !Array.isArray(repositories.repositories) ||
    repositories.repositories.length !== 1 ||
    repositories.repositories[0].id !== 1259761852 ||
    repositories.repositories[0].full_name !== "milos-agathon/forge3d-web"
  ) {
    throw new Error("trust-observer token is not scoped to the canonical repository");
  }
  return {
    token: body.token,
    expiresAt: body.expires_at,
    permissions: body.permissions ?? {},
    repositorySelection: body.repository_selection ?? null,
  };
}

function sortObject(value) {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function base64Url(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await mintGitHubAppInstallationToken({
    appId: process.env.TRUST_OBSERVER_APP_ID,
    installationId: process.env.TRUST_OBSERVER_INSTALLATION_ID,
    privateKey: process.env.TRUST_OBSERVER_PRIVATE_KEY?.replaceAll("\\n", "\n"),
  });
  if (!process.env.GITHUB_OUTPUT) {
    throw new Error("GITHUB_OUTPUT is required so the token is never printed");
  }
  process.stdout.write(`::add-mask::${result.token}\n`);
  appendFileSync(process.env.GITHUB_OUTPUT, `token=${result.token}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}
