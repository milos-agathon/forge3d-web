import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
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
  enforcement,
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
  validateEnforcement({
    enforcement,
    operation: "freeze",
    assetId,
    resolvedChannels,
  });
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
    enforcement: {
      helper: enforcement.helper,
      freezeObservedAt: enforcement.observedAt,
      freezeReceipt: enforcement.receipt,
      restoreObservedAt: null,
      restoreReceipt: null,
    },
    unfrozenAt: null,
    cleanupAttempted: false,
  };
}

export function createPendingUpdateWindow({
  assetId,
  resolvedChannels,
  helper,
  attemptedAt = new Date(),
}) {
  if (
    !/^FW-(?:MAC|WIN|LNX)-[A-Z0-9-]+$/u.test(assetId ?? "") ||
    !isAbsolute(helper ?? "") ||
    !Array.isArray(resolvedChannels) ||
    resolvedChannels.length === 0
  ) {
    throw new Error("pending update control record is invalid");
  }
  return {
    schemaVersion: 1,
    assetId,
    state: "freeze_attempted",
    resolvedChannels,
    enforcement: {
      helper,
      freezeAttemptedAt: new Date(attemptedAt).toISOString(),
      freezeObservedAt: null,
      freezeReceipt: null,
      restoreObservedAt: null,
      restoreReceipt: null,
    },
    cleanupAttempted: false,
    unfrozenAt: null,
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

export function closeUpdateWindow(
  record,
  unfrozenAt = new Date(),
  enforcement,
) {
  validateEnforcement({
    enforcement,
    operation: "unfreeze",
    assetId: record.assetId,
    resolvedChannels: record.resolvedChannels,
  });
  const result = structuredClone(record);
  result.state = "unfrozen";
  result.unfrozenAt = new Date(unfrozenAt).toISOString();
  result.cleanupAttempted = true;
  result.enforcement.restoreObservedAt = enforcement.observedAt;
  result.enforcement.restoreReceipt = enforcement.receipt;
  return result;
}

export function enforceHostUpdatePolicy({
  helper,
  operation,
  assetId,
  resolvedChannels,
  execute = execFileSync,
}) {
  if (
    !isAbsolute(helper ?? "") ||
    !["freeze", "unfreeze"].includes(operation) ||
    !/^FW-(?:MAC|WIN|LNX)-[A-Z0-9-]+$/u.test(assetId ?? "")
  ) {
    throw new Error("update control requires an absolute helper and fixed host");
  }
  const stdout = execute(
    helper,
    [
      operation,
      "--asset-id",
      assetId,
      "--resolved-channels-json",
      JSON.stringify(resolvedChannels),
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const receipt = JSON.parse(stdout);
  const enforcement = {
    helper,
    observedAt: receipt.observedAt,
    receipt,
  };
  validateEnforcement({
    enforcement,
    operation,
    assetId,
    resolvedChannels,
  });
  return enforcement;
}

function validateEnforcement({
  enforcement,
  operation,
  assetId,
  resolvedChannels,
}) {
  const expectedState = operation === "freeze" ? "disabled" : "restored";
  if (
    !enforcement ||
    !isAbsolute(enforcement.helper ?? "") ||
    enforcement.receipt?.schemaVersion !== 1 ||
    enforcement.receipt.operation !== operation ||
    enforcement.receipt.assetId !== assetId ||
    enforcement.receipt.osUpdates !== expectedState ||
    !Number.isFinite(Date.parse(enforcement.observedAt)) ||
    enforcement.receipt.observedAt !== enforcement.observedAt
  ) {
    throw new Error(`host update ${operation} enforcement was not proven`);
  }
  const actual = new Map(
    (enforcement.receipt.browserUpdates ?? []).map((entry) => [
      entry.id,
      entry,
    ]),
  );
  for (const channel of resolvedChannels) {
    const entry = actual.get(channel.id);
    if (
      entry?.version !== channel.version ||
      entry.state !== expectedState
    ) {
      throw new Error(
        `host update ${operation} receipt does not cover ${channel.id}`,
      );
    }
  }
  if (actual.size !== resolvedChannels.length) {
    throw new Error(`host update ${operation} receipt contains extra channels`);
  }
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
    const resolvedChannels = JSON.parse(readFileSync(channelsPath, "utf8"));
    writeState(
      statePath,
      createPendingUpdateWindow({
        assetId: args.get("--asset-id"),
        resolvedChannels,
        helper: process.env.FORGE3D_UPDATE_CONTROL_HELPER,
      }),
    );
    const enforcement = enforceHostUpdatePolicy({
      helper: process.env.FORGE3D_UPDATE_CONTROL_HELPER,
      operation,
      assetId: args.get("--asset-id"),
      resolvedChannels,
    });
    const record = createUpdateWindow({
      assetId: args.get("--asset-id"),
      resolvedChannels,
      policy,
      enforcement,
    });
    writeState(statePath, record);
  } else {
    const record = JSON.parse(readFileSync(statePath, "utf8"));
    if (operation === "verify") {
      assertUpdateWindowActive(record);
    } else {
      const enforcement = enforceHostUpdatePolicy({
        helper: process.env.FORGE3D_UPDATE_CONTROL_HELPER,
        operation,
        assetId: record.assetId,
        resolvedChannels: record.resolvedChannels,
      });
      writeState(
        statePath,
        closeUpdateWindow(record, new Date(), enforcement),
      );
    }
  }
  console.log(JSON.stringify({ ok: true, operation, state: statePath }));
}

function writeState(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}
