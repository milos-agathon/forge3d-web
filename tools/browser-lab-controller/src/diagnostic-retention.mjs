import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";

import { canonicalJson } from "./controller-signing.mjs";

const DIAGNOSTIC_NAME = /^(?:Runner|Worker)_[A-Za-z0-9_.-]+\.log$/u;
const TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const TOKEN_KEY =
  String.raw`(?:token|access[ _-]?token|refresh[ _-]?token|registration[ _-]?token|runner[ _-]?token|github[ _-]?token|oauth[ _-]?token|auth[ _-]?token|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_TOKEN)`;
const JIT_KEY =
  String.raw`(?:jitconfig|jit[ _-]?(?:config|configuration)|encoded[ _-]?jit[ _-]?(?:config|configuration))`;
const MOBILE_KEY =
  String.raw`(?:(?:[A-Z][A-Z0-9_.-]*:)?(?:udid|imei|meid|serial(?:[ _-]?number)?|android[ _-]?serial|device[ _-]?(?:serial|identifier|id|address)|mobile[ _-]?identifier|bluetooth[ _-]?(?:address|id)|mac[ _-]?address|location[ _-]?id))`;
const AUTHORIZATION_KEY = String.raw`authorization(?:[ _-]+header)?`;
const SCALAR_VALUE = String.raw`(?:\[REDACTED_[A-Z_]+\]|"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s&,;}\]]+)`;
const PRIVATE_KEY_HEADER = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/iu;

export function retainRunnerDiagnostics({
  source,
  destination,
  authorizationDigest,
  hostId,
  run,
  runnerNonce,
  storageKey,
  now = new Date(),
  writeFile = writeFileSync,
}) {
  const destinationRelation = relative(source ?? "", destination ?? "");
  if (
    !isAbsolute(source ?? "") ||
    !isAbsolute(destination ?? "") ||
    !/^[0-9a-f]{64}$/u.test(authorizationDigest ?? "") ||
    !/^FW-(?:MAC|WIN|LNX)-[A-Z0-9-]+$/u.test(hostId ?? "") ||
    !Number.isInteger(run?.id) ||
    run.id < 1 ||
    !Number.isInteger(run?.attempt) ||
    run.attempt < 1 ||
    !/^[0-9a-f]{32}$/u.test(runnerNonce ?? "") ||
    storageKey !==
      `${hostId}-${run?.id}-${run?.attempt}-${authorizationDigest}` ||
    existsSync(destination) ||
    !existsSync(source) ||
    lstatSync(source).isSymbolicLink() ||
    !lstatSync(source).isDirectory() ||
    destinationRelation === "" ||
    (destinationRelation !== ".." &&
      !destinationRelation.startsWith(`..${sep}`))
  ) {
    throw new Error("runner diagnostic retention paths are invalid");
  }
  const entries = readdirSync(source, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  if (
    entries.length < 2 ||
    entries.some(
      (entry) =>
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        !DIAGNOSTIC_NAME.test(entry.name),
    ) ||
    !entries.some((entry) => entry.name.startsWith("Runner_")) ||
    !entries.some((entry) => entry.name.startsWith("Worker_"))
  ) {
    throw new Error("runner diagnostics are absent or contain unknown entries");
  }
  const retained = entries.map((entry) => {
    let bytes;
    try {
      bytes = readFileSync(join(source, entry.name));
    } catch {
      throw new Error("runner diagnostic source read failed");
    }
    if (bytes.length < 1) {
      throw new Error(`runner diagnostic is empty: ${entry.name}`);
    }
    const redactedBytes = redactDiagnosticBytes(bytes);
    return { name: entry.name, bytes: redactedBytes };
  });
  const files = retained.map(({ name, bytes }) => ({
    name,
    size: bytes.length,
    sha256: sha256(bytes),
  }));
  try {
    mkdirSync(destination, { recursive: false, mode: 0o700 });
    for (const { name, bytes } of retained) {
      const file = files.find((candidate) => candidate.name === name);
      const retainedPath = join(destination, basename(file.name));
      writeFile(retainedPath, bytes, { flag: "wx", mode: 0o600 });
      chmodSync(retainedPath, 0o600);
      const retainedBytes = readFileSync(retainedPath);
      if (
        retainedBytes.length !== file.size ||
        sha256(retainedBytes) !== file.sha256 ||
        !isSafeRedactedText(retainedBytes)
      ) {
        throw new Error("retained runner diagnostic validation failed");
      }
    }
  } catch {
    if (existsSync(destination)) {
      rmSync(destination, { recursive: true, force: true });
    }
    throw new Error("runner diagnostic external copy failed");
  }
  const record = {
    schemaVersion: 1,
    storage: "protected-controller-external",
    storageKey,
    hostId,
    run: { id: run.id, attempt: run.attempt },
    runnerNonce,
    authorizationDigest,
    files,
    filesSha256: sha256(Buffer.from(canonicalJson(files))),
    retainedAt: new Date(now).toISOString(),
  };
  return { ...record, sha256: sha256(Buffer.from(canonicalJson(record))) };
}

export function validateDiagnosticRetentionReceipt(
  receipt,
  { authorizationDigest, hostId, run, runnerNonce },
) {
  const { sha256: receiptSha256, ...record } = receipt ?? {};
  const files = record.files;
  if (
    Object.keys(receipt ?? {}).sort().join(",") !==
      "authorizationDigest,files,filesSha256,hostId,retainedAt,run,runnerNonce,schemaVersion,sha256,storage,storageKey" ||
    record.schemaVersion !== 1 ||
    record.storage !== "protected-controller-external" ||
    record.storageKey !==
      `${hostId}-${run?.id}-${run?.attempt}-${authorizationDigest}` ||
    record.hostId !== hostId ||
    Object.keys(record.run ?? {}).sort().join(",") !== "attempt,id" ||
    record.run.id !== run?.id ||
    record.run.attempt !== run?.attempt ||
    record.runnerNonce !== runnerNonce ||
    record.authorizationDigest !== authorizationDigest ||
    !Array.isArray(files) ||
    files.length < 2 ||
    files.some(
      (file) =>
        Object.keys(file ?? {}).sort().join(",") !== "name,sha256,size" ||
        !DIAGNOSTIC_NAME.test(file.name ?? "") ||
        !Number.isInteger(file.size) ||
        file.size < 1 ||
        !/^[0-9a-f]{64}$/u.test(file.sha256 ?? ""),
    ) ||
    !files.some((file) => file.name.startsWith("Runner_")) ||
    !files.some((file) => file.name.startsWith("Worker_")) ||
    new Set(files.map((file) => file.name)).size !== files.length ||
    canonicalJson(files) !==
      canonicalJson([...files].sort((left, right) => left.name.localeCompare(right.name))) ||
    record.filesSha256 !== sha256(Buffer.from(canonicalJson(files))) ||
    !Number.isFinite(Date.parse(record.retainedAt)) ||
    receiptSha256 !== sha256(Buffer.from(canonicalJson(record)))
  ) {
    throw new Error("runner diagnostic retention receipt is invalid");
  }
  return receipt;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function redactDiagnosticBytes(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("runner diagnostic redaction failed");
  }
  if (TEXT_CONTROL.test(text) || PRIVATE_KEY_HEADER.test(text)) {
    throw new Error("runner diagnostic redaction failed");
  }
  const redacted = applyDiagnosticRedactions(text);
  if (hasForbiddenResidual(redacted)) {
    throw new Error("runner diagnostic redaction failed");
  }
  return Buffer.from(redacted, "utf8");
}

function applyDiagnosticRedactions(text) {
  let result = text;
  result = redactStructuredFields(
    result,
    AUTHORIZATION_KEY,
    "[REDACTED_AUTHORIZATION]",
    true,
  );
  result = redactStructuredFields(result, TOKEN_KEY, "[REDACTED_TOKEN]");
  result = redactStructuredFields(result, JIT_KEY, "[REDACTED_JIT_CONFIG]");
  result = redactStructuredFields(
    result,
    MOBILE_KEY,
    "[REDACTED_MOBILE_IDENTIFIER]",
  );
  result = redactArgv(result, TOKEN_KEY, "[REDACTED_TOKEN]");
  result = redactArgv(result, JIT_KEY, "[REDACTED_JIT_CONFIG]");
  result = redactArgv(result, MOBILE_KEY, "[REDACTED_MOBILE_IDENTIFIER]");
  result = result.replace(
    new RegExp(
      String.raw`\b(Bearer|Basic)([ \t]+)(?!\[REDACTED_)([^\s&,;}\]]+)`,
      "giu",
    ),
    "$1$2[REDACTED_TOKEN]",
  );
  result = result.replace(
    /\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,})\b/gu,
    "[REDACTED_TOKEN]",
  );
  result = redactControllerPaths(result);
  return result;
}

function redactStructuredFields(text, key, marker, authorization = false) {
  const value = authorization
    ? String.raw`(?:\[REDACTED_[A-Z_]+\]|"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|(?:Bearer|Basic)[ \t]+[^\s&,;}\]]+|[^\s&,;}\]]+)`
    : SCALAR_VALUE;
  const pattern = new RegExp(
    String.raw`(^|[?&,\s{\[])((?:["'])?(?:${key})(?:["'])?)([ \t]*(?:=|:)[ \t]*(?:\r?\n[ \t]+)?)(${value})`,
    "gimu",
  );
  return text.replace(pattern, (_match, prefix, label, separator, fieldValue) =>
    `${prefix}${label}${separator}${quotedMarker(fieldValue, marker)}`,
  );
}

function redactArgv(text, key, marker) {
  const shellArg = new RegExp(
    String.raw`(^|[\s,\[])(--(?:${key}))((?:[ \t]*=[ \t]*|[ \t]+)(?:\r?\n[ \t]+)?)(${SCALAR_VALUE})`,
    "gimu",
  );
  const jsonArg = new RegExp(
    String.raw`(["']--(?:${key})["'])([ \t]*,[ \t]*)(${SCALAR_VALUE})`,
    "gimu",
  );
  return text
    .replace(shellArg, (_match, prefix, label, separator, value) =>
      `${prefix}${label}${separator}${quotedMarker(value, marker)}`,
    )
    .replace(jsonArg, (_match, label, separator, value) =>
      `${label}${separator}${quotedMarker(value, marker)}`,
    );
}

function quotedMarker(value, marker) {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return `${value[0]}${marker}${value.at(-1)}`;
  }
  return marker;
}

function redactControllerPaths(text) {
  return text
    .replace(
      /\/(?:Users|home)\/[^\s"'<>]+|\/root(?:\/[^\s"'<>]+)?/giu,
      "[REDACTED_CONTROLLER_PATH]",
    )
    .replace(
      /[A-Z]:\\Users\\[^\s"'<>]+|\\\\[^\\\s"'<>]+\\[^\s"'<>]+/giu,
      "[REDACTED_CONTROLLER_PATH]",
    )
    .replace(
      /\/(?:[^\s/"'<>]+\/)*[^\s/"'<>]*(?:controller|forge3d-lab)[^\s/"'<>]*(?:\/[^\s"'<>]+)*/giu,
      "[REDACTED_CONTROLLER_PATH]",
    );
}

function hasForbiddenResidual(text) {
  if (TEXT_CONTROL.test(text) || PRIVATE_KEY_HEADER.test(text)) return true;
  if (applyDiagnosticRedactions(text) !== text) return true;
  const sensitiveKey = `(?:${AUTHORIZATION_KEY}|${TOKEN_KEY}|${JIT_KEY}|${MOBILE_KEY})`;
  const unsupportedSeparator = new RegExp(
    String.raw`(?:--)?["']?(?:${sensitiveKey})["']?[ \t]*(?:=>|->|\|)[ \t]*\S+`,
    "imu",
  );
  const whitespaceOnlyField = new RegExp(
    String.raw`^[ \t]*["']?(?:${sensitiveKey})["']?[ \t]+(?!\[REDACTED_|(?:Bearer|Basic)[ \t]+\[REDACTED_)\S+`,
    "imu",
  );
  return unsupportedSeparator.test(text) || whitespaceOnlyField.test(text);
}

function isSafeRedactedText(bytes) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return !hasForbiddenResidual(text);
  } catch {
    return false;
  }
}
