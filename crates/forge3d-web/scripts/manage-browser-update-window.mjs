import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultPolicyPath = join(
  packageRoot,
  "tests",
  "infrastructure",
  "browser-policy.json",
);

export function createUpdateWindow({
  assetId,
  resolvedChannels,
  frozenAt = new Date(),
  policy,
}) {
  if (!Array.isArray(resolvedChannels) || resolvedChannels.length === 0) {
    throw new Error("resolvedChannels must contain exact installed browser versions");
  }
  const resolvedIds = new Set();
  for (const channel of resolvedChannels) {
    if (resolvedIds.has(channel.id)) {
      throw new Error(`duplicate resolved browser channel: ${channel.id}`);
    }
    resolvedIds.add(channel.id);
    const checked = policy.channels.find((entry) => entry.id === channel.id);
    if (!checked || !/^[0-9]+(?:\.[0-9A-Za-z-]+)+$/u.test(channel.version)) {
      throw new Error(`invalid resolved browser channel: ${channel.id}`);
    }
  }
  const start = new Date(frozenAt);
  return {
    schemaVersion: 1,
    assetId,
    state: "frozen",
    frozenAt: start.toISOString(),
    expiresAt: new Date(
      start.getTime() + policy.acceptanceWindowHours * 60 * 60 * 1000,
    ).toISOString(),
    resolvedChannels: resolvedChannels.map(({ id, version }) => ({ id, version })),
    unfrozenAt: null,
    cleanupAttempted: false,
  };
}

export function assertUpdateWindowActive(record, now = new Date()) {
  if (record.state !== "frozen" || record.cleanupAttempted) {
    throw new Error("browser update window is not active");
  }
  if (new Date(now) > new Date(record.expiresAt)) {
    throw new Error("browser update window exceeded the checked 24-hour maximum");
  }
}

export function closeUpdateWindow(record, unfrozenAt = new Date()) {
  const result = structuredClone(record);
  result.state = "unfrozen";
  result.unfrozenAt = new Date(unfrozenAt).toISOString();
  result.cleanupAttempted = true;
  return result;
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
  const operation = args.get("--operation");
  const statePath = args.get("--state");
  if (!statePath || !["freeze", "verify", "unfreeze"].includes(operation)) {
    throw new Error("--operation freeze|verify|unfreeze and --state are required");
  }
  const policy = JSON.parse(
    readFileSync(args.get("--policy") ?? defaultPolicyPath, "utf8"),
  );
  if (operation === "freeze") {
    const channelsPath = args.get("--resolved-channels");
    if (!channelsPath || !args.get("--asset-id")) {
      throw new Error("freeze requires --asset-id and --resolved-channels");
    }
    const record = createUpdateWindow({
      assetId: args.get("--asset-id"),
      resolvedChannels: JSON.parse(readFileSync(channelsPath, "utf8")),
      policy,
    });
    writeFileSync(statePath, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } else {
    const record = JSON.parse(readFileSync(statePath, "utf8"));
    if (operation === "verify") {
      assertUpdateWindowActive(record);
    } else {
      writeFileSync(
        statePath,
        `${JSON.stringify(closeUpdateWindow(record), null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    }
  }
  console.log(JSON.stringify({ ok: true, operation, state: statePath }));
}
