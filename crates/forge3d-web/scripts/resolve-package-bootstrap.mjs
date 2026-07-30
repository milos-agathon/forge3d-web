import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const policyPath = join(
  packageRoot,
  "tests",
  "infrastructure",
  "repository-trust-policy.json",
);

export function resolvePackageBootstrap(policy, { eventName }) {
  if (!["push", "workflow_dispatch"].includes(eventName)) {
    throw new Error(`unsupported package event: ${eventName}`);
  }

  const pending =
    policy.bootstrapState === "pending-protection-canary" &&
    policy.trustEpochSha === null;
  if (pending) {
    if (eventName === "push") {
      return {
        packageEnabled: false,
        reason: "repository trust bootstrap is pending",
      };
    }
    throw new Error(
      "manual packaging requires active repository trust and a pinned epoch SHA",
    );
  }

  const active =
    policy.bootstrapState === "active" &&
    /^[0-9a-f]{40}$/u.test(policy.trustEpochSha ?? "");
  if (!active) {
    throw new Error(
      "repository trust policy has an inconsistent bootstrap state or epoch SHA",
    );
  }
  return {
    packageEnabled: true,
    reason: "repository trust bootstrap is active",
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.env.GITHUB_OUTPUT) {
    throw new Error("GITHUB_OUTPUT is required");
  }
  const policy = JSON.parse(readFileSync(policyPath, "utf8"));
  const result = resolvePackageBootstrap(policy, {
    eventName: process.env.GITHUB_EVENT_NAME,
  });
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `package-enabled=${result.packageEnabled}\n`,
  );
  console.log(result.reason);
}
