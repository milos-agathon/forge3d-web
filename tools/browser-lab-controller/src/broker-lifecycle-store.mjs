const lifecycleStates = new Set([
  "issued",
  "online_unassigned",
  "assigned",
  "busy",
  "assignment_timeout",
  "terminal",
  "deleted",
  "already_absent",
  "quarantined",
]);

export class BrokerLifecycleStore {
  constructor({ hostId }) {
    if (!/^FW-(?:MAC|WIN|LNX)-[A-Z0-9-]+$/u.test(hostId ?? "")) {
      throw new Error("broker lifecycle store host identity is invalid");
    }
    this.hostId = hostId;
    this.records = new Map();
  }

  observe(record) {
    validateObservation(record, this.hostId);
    const previous = this.records.get(record.authorizationDigest);
    if (previous) {
      if (
        previous.runnerId !== record.runnerId ||
        previous.runnerName !== record.runnerName ||
        (previous.onlineAt !== null &&
          record.onlineAt !== previous.onlineAt) ||
        (previous.assignmentDeadline !== null &&
          record.assignmentDeadline !== previous.assignmentDeadline) ||
        Date.parse(record.publishedAt) < Date.parse(previous.publishedAt)
      ) {
        throw new Error("broker lifecycle observation regressed or changed identity");
      }
    }
    this.records.set(
      record.authorizationDigest,
      Object.freeze(structuredClone(record)),
    );
  }

  get({ authorizationDigest, runnerId, runnerName }) {
    const record = this.records.get(authorizationDigest);
    if (
      !record ||
      record.runnerId !== runnerId ||
      record.runnerName !== runnerName
    ) {
      return null;
    }
    return structuredClone(record);
  }
}

export function decodeBrokerLifecycleHeader(value) {
  if (
    typeof value !== "string" ||
    value.length < 20 ||
    value.length > 4096 ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw new Error("broker lifecycle header encoding is invalid");
  }
  let record;
  try {
    record = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("broker lifecycle header is malformed");
  }
  return record;
}

function validateObservation(record, hostId) {
  const expectedKeys = [
    "assignmentDeadline",
    "authorizationDigest",
    "everBusy",
    "hostAssetId",
    "lastJobObservation",
    "lastRunnerObservation",
    "onlineAt",
    "publishedAt",
    "runnerId",
    "runnerName",
    "schemaVersion",
    "state",
  ].sort();
  const actualKeys = Object.keys(record ?? {}).sort();
  if (
    JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys) ||
    record.schemaVersion !== 1 ||
    record.hostAssetId !== hostId ||
    !/^[0-9a-f]{64}$/u.test(record.authorizationDigest ?? "") ||
    !Number.isInteger(record.runnerId) ||
    record.runnerId < 1 ||
    !new RegExp(`^${hostId}-[0-9a-f]{32}$`, "u").test(
      record.runnerName ?? "",
    ) ||
    !lifecycleStates.has(record.state) ||
    typeof record.everBusy !== "boolean" ||
    !validOptionalDate(record.onlineAt) ||
    !validOptionalDate(record.assignmentDeadline) ||
    !Number.isFinite(Date.parse(record.publishedAt))
  ) {
    throw new Error("broker lifecycle observation identity is invalid");
  }
  if (
    (record.onlineAt === null) !== (record.assignmentDeadline === null) ||
    (record.onlineAt !== null &&
      Date.parse(record.assignmentDeadline) < Date.parse(record.onlineAt))
  ) {
    throw new Error("broker lifecycle assignment window is invalid");
  }
  validateRunnerObservation(record.lastRunnerObservation, record);
  validateJobObservation(record.lastJobObservation);
}

function validateRunnerObservation(observation, record) {
  if (observation === null) return;
  const keys = Object.keys(observation).sort();
  if (
    JSON.stringify(keys) !==
      JSON.stringify(["busy", "id", "name", "observedAt", "status"]) ||
    observation.id !== record.runnerId ||
    observation.name !== record.runnerName ||
    !["online", "offline"].includes(observation.status) ||
    typeof observation.busy !== "boolean" ||
    !Number.isFinite(Date.parse(observation.observedAt))
  ) {
    throw new Error("broker runner observation is invalid");
  }
}

function validateJobObservation(observation) {
  if (observation === null) return;
  const keys = Object.keys(observation).sort();
  if (
    JSON.stringify(keys) !==
      JSON.stringify(["conclusion", "id", "observedAt", "status"]) ||
    !Number.isInteger(observation.id) ||
    observation.id < 1 ||
    !["queued", "in_progress", "completed"].includes(observation.status) ||
    !Number.isFinite(Date.parse(observation.observedAt))
  ) {
    throw new Error("broker job observation is invalid");
  }
}

function validOptionalDate(value) {
  return value === null || Number.isFinite(Date.parse(value));
}
