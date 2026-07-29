import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function createRunNonce({
  runId,
  jobId,
  seen = new Set(),
  random = randomBytes,
}) {
  if (!Number.isInteger(runId) || runId < 1 || !Number.isInteger(jobId) || jobId < 1) {
    throw new Error("runId and jobId must be positive integers");
  }
  const nonce = random(16).toString("hex");
  if (!/^[0-9a-f]{32}$/u.test(nonce)) {
    throw new Error("nonce source did not return 128 random bits");
  }
  const key = `${runId}:${nonce}`;
  if (seen.has(key)) {
    throw new Error("nonce reuse within a workflow run is prohibited");
  }
  seen.add(key);
  return {
    runId,
    jobId,
    nonce,
    basePath: `/runs/${runId}/${jobId}/${nonce}/`,
  };
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
  const runId = Number(args.get("--run-id"));
  const jobId = Number(args.get("--job-id"));
  const output = args.get("--output");
  const registryPath = args.get("--registry");
  if (!output || !registryPath) {
    throw new Error("--output and --registry are required");
  }
  const registry = JSON.parse(readFileSync(registryPath, "utf8"));
  if (!Array.isArray(registry.nonces)) {
    throw new Error("nonce registry must contain a nonces array");
  }
  const seen = new Set(registry.nonces.map((nonce) => `${runId}:${nonce}`));
  const record = createRunNonce({ runId, jobId, seen });
  registry.nonces.push(record.nonce);
  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  writeFileSync(output, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(JSON.stringify({ ok: true, basePath: record.basePath }));
}
