import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  retainRunnerDiagnostics,
  validateDiagnosticRetentionReceipt,
} from "../src/diagnostic-retention.mjs";
import { assertJsonSchema } from "../../../crates/forge3d-web/tests/browser/json-schema-validator.mjs";

const schema = JSON.parse(
  readFileSync(
    new URL(
      "../../../crates/forge3d-web/tests/infrastructure/runner-diagnostic-retention.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const identity = {
  authorizationDigest: "a".repeat(64),
  hostId: "FW-LNX-NV-01",
  run: { id: 10, attempt: 2 },
  runnerNonce: "b".repeat(32),
};
const storageKey =
  `${identity.hostId}-${identity.run.id}-${identity.run.attempt}-${identity.authorizationDigest}`;

test("runner diagnostics are copied externally and produce a bound hash receipt", () => {
  const fixture = diagnosticFixture();
  try {
    const receipt = retainRunnerDiagnostics({
      ...identity,
      ...fixture,
      storageKey,
      now: new Date("2026-07-29T10:00:00.000Z"),
    });
    assertJsonSchema(receipt, schema);
    validateDiagnosticRetentionReceipt(receipt, identity);
    assert.deepEqual(
      receipt.files.map((file) => file.name),
      ["Runner_20260729-100000.log", "Worker_20260729-100001.log"],
    );
    assert.equal(
      readFileSync(join(fixture.destination, receipt.files[0].name), "utf8"),
      "runner diagnostic",
    );
  } finally {
    fixture.cleanup();
  }
});

test("required diagnostic classes are redacted before receipt hashes are computed", () => {
  const secrets = {
    authorization: "test-authorization-value",
    jsonToken: "test-json-token-value",
    queryToken: "test-query-token-value",
    argvToken: "test-argv-token-value",
    jitConfig: "test-encoded-jit-configuration",
    jitConfiguration: "test-spaced-encoded-jit-configuration",
    mobileId: "00008030-test-private-udid",
    serial: "test-private-serial-number",
    locationId: "test-private-mobile-location-id",
    posixPath: "/Users/forge3d-lab-controller/private/work",
    windowsPath: "C:\\Users\\Forge3D-Lab-Controller\\private\\work",
  };
  const runnerContents = [
    `aUtHoRiZaTiOn:\r\n  bEaReR ${secrets.authorization}`,
    `{"ToKeN":\n "${secrets.jsonToken}"}`,
    `https://example.invalid/run?access_token=${secrets.queryToken}&safe=1`,
    `["--refresh-token","${secrets.argvToken}"]`,
    `--ENCODED_jit_CONFIG ${secrets.jitConfig}`,
    `{"Encoded JIT Configuration":"${secrets.jitConfiguration}"}`,
    `UDID: ${secrets.mobileId}`,
    `serialNumber=${secrets.serial}`,
    `Location ID: ${secrets.locationId}`,
    `{"controllerPath":"${secrets.posixPath}"}`,
    `controllerPath=${secrets.windowsPath}`,
  ].join("\n");
  const fixture = diagnosticFixture({ runnerContents });
  try {
    const receipt = retainRunnerDiagnostics({
      ...identity,
      ...fixture,
      storageKey,
    });
    const retainedPath = join(fixture.destination, receipt.files[0].name);
    const retainedBytes = readFileSync(retainedPath);
    const retainedText = retainedBytes.toString("utf8");
    for (const secret of Object.values(secrets)) {
      assert.equal(retainedText.includes(secret), false);
    }
    assert.match(retainedText, /\[REDACTED_AUTHORIZATION\]/u);
    assert.match(retainedText, /\[REDACTED_TOKEN\]/u);
    assert.match(retainedText, /\[REDACTED_JIT_CONFIG\]/u);
    assert.match(retainedText, /\[REDACTED_MOBILE_IDENTIFIER\]/u);
    assert.match(retainedText, /\[REDACTED_CONTROLLER_PATH\]/u);
    assert.equal(receipt.files[0].size, retainedBytes.length);
    assert.equal(receipt.files[0].sha256, sha256(retainedBytes));
  } finally {
    fixture.cleanup();
  }
});

test("namespaced mobile IDs and environment token keys are redacted exactly", () => {
  const runnerContents = [
    '{"appium:udid":"SYNTHETIC_PRIVATE_DEVICE"}',
    '{"vendor:deviceId":"SYNTHETIC_VENDOR_DEVICE"}',
    "ACTIONS_RUNTIME_TOKEN=SYNTHETIC_PRIVATE_TOKEN",
    "CUSTOM_SECRET_TOKEN=SYNTHETIC_CUSTOM_TOKEN",
    "tokenCount=7",
    "TOKEN_VERSION=2",
  ].join("\n");
  const expected = [
    '{"appium:udid":"[REDACTED_MOBILE_IDENTIFIER]"}',
    '{"vendor:deviceId":"[REDACTED_MOBILE_IDENTIFIER]"}',
    "ACTIONS_RUNTIME_TOKEN=[REDACTED_TOKEN]",
    "CUSTOM_SECRET_TOKEN=[REDACTED_TOKEN]",
    "tokenCount=7",
    "TOKEN_VERSION=2",
  ].join("\n");
  const fixture = diagnosticFixture({ runnerContents });
  try {
    const receipt = retainRunnerDiagnostics({
      ...identity,
      ...fixture,
      storageKey,
    });
    const retainedBytes = readFileSync(
      join(fixture.destination, receipt.files[0].name),
    );
    assert.equal(retainedBytes.toString("utf8"), expected);
    assert.equal(receipt.files[0].size, Buffer.byteLength(expected));
    assert.equal(receipt.files[0].sha256, sha256(Buffer.from(expected)));
  } finally {
    fixture.cleanup();
  }
});

test("diagnostic redaction is idempotent", () => {
  const first = diagnosticFixture({
    runnerContents:
      'Authorization: Bearer test-idempotent-value\n{"token":"test-json-value"}\nUDID: test-device-value',
  });
  let retainedText;
  try {
    const receipt = retainRunnerDiagnostics({ ...identity, ...first, storageKey });
    retainedText = readFileSync(
      join(first.destination, receipt.files[0].name),
      "utf8",
    );
  } finally {
    first.cleanup();
  }
  const second = diagnosticFixture({ runnerContents: retainedText });
  try {
    const receipt = retainRunnerDiagnostics({ ...identity, ...second, storageKey });
    assert.equal(
      readFileSync(join(second.destination, receipt.files[0].name), "utf8"),
      retainedText,
    );
  } finally {
    second.cleanup();
  }
});

test("absent, empty, and unknown runner diagnostics fail closed", () => {
  const missing = diagnosticFixture({ createSource: false });
  try {
    assert.throws(
      () => retainRunnerDiagnostics({ ...identity, ...missing, storageKey }),
      /paths are invalid/u,
    );
  } finally {
    missing.cleanup();
  }

  const empty = diagnosticFixture({ runnerContents: "" });
  try {
    assert.throws(
      () => retainRunnerDiagnostics({ ...identity, ...empty, storageKey }),
      /diagnostic is empty/u,
    );
  } finally {
    empty.cleanup();
  }

  const unknown = diagnosticFixture({ unknownEntry: true });
  try {
    assert.throws(
      () => retainRunnerDiagnostics({ ...identity, ...unknown, storageKey }),
      /unknown entries/u,
    );
  } finally {
    unknown.cleanup();
  }
});

test("write failure removes the partial external destination without leaking details", () => {
  const fixture = diagnosticFixture();
  try {
    const failure = captureError(
      () =>
        retainRunnerDiagnostics({
          ...identity,
          ...fixture,
          storageKey,
          writeFile: () => {
            throw new Error("test-sensitive-write-detail");
          },
        }),
    );
    assert.match(failure.message, /external copy failed/u);
    assert.equal(failure.message.includes("test-sensitive-write-detail"), false);
    assert.equal(existsSync(fixture.destination), false);
  } finally {
    fixture.cleanup();
  }
});

test("non-text diagnostics and ambiguous residual secret syntax fail closed", () => {
  const cases = [
    { contents: Buffer.from([0xc3, 0x28]), secret: null },
    { contents: Buffer.from("safe\u0000binary"), secret: null },
    {
      contents:
        "token -> test-residual-token-value\n-----BEGIN PRIVATE KEY-----\ntest-private-key-value",
      secret: "test-residual-token-value",
    },
    {
      contents: "encoded_jit_config -> test-residual-jit-value",
      secret: "test-residual-jit-value",
    },
    {
      contents: "UDID -> test-residual-mobile-value",
      secret: "test-residual-mobile-value",
    },
    {
      contents: "Authorization -> test-residual-authorization-value",
      secret: "test-residual-authorization-value",
    },
    {
      contents: "token test-whitespace-token-value",
      secret: "test-whitespace-token-value",
    },
    {
      contents: "encodedJitConfig test-whitespace-jit-value",
      secret: "test-whitespace-jit-value",
    },
    {
      contents: "UDID test-whitespace-mobile-value",
      secret: "test-whitespace-mobile-value",
    },
    {
      contents: "Authorization test-whitespace-authorization-value",
      secret: "test-whitespace-authorization-value",
    },
    {
      contents: "appium:udid -> SYNTHETIC_RESIDUAL_DEVICE",
      secret: "SYNTHETIC_RESIDUAL_DEVICE",
    },
    {
      contents: "ACTIONS_RUNTIME_TOKEN SYNTHETIC_RESIDUAL_TOKEN",
      secret: "SYNTHETIC_RESIDUAL_TOKEN",
    },
  ];
  for (const { contents, secret } of cases) {
    const fixture = diagnosticFixture({ runnerContents: contents });
    try {
      const failure = captureError(
        () => retainRunnerDiagnostics({ ...identity, ...fixture, storageKey }),
      );
      assert.match(failure.message, /redaction failed/u);
      if (secret !== null) assert.equal(failure.message.includes(secret), false);
      assert.equal(existsSync(fixture.destination), false);
    } finally {
      fixture.cleanup();
    }
  }
});

test("post-write changes fail validation and remove retained diagnostics", () => {
  const fixture = diagnosticFixture();
  try {
    assert.throws(
      () =>
        retainRunnerDiagnostics({
          ...identity,
          ...fixture,
          storageKey,
          writeFile: (path, _bytes, options) =>
            writeFileSync(path, "changed after redaction", options),
        }),
      /external copy failed/u,
    );
    assert.equal(existsSync(fixture.destination), false);
  } finally {
    fixture.cleanup();
  }
});

test("receipt validation recomputes digests and rejects extra or private fields", () => {
  const fixture = diagnosticFixture();
  try {
    const receipt = retainRunnerDiagnostics({
      ...identity,
      ...fixture,
      storageKey,
    });
    const digestMismatch = structuredClone(receipt);
    digestMismatch.files[0].sha256 = "f".repeat(64);
    assert.throws(
      () => validateDiagnosticRetentionReceipt(digestMismatch, identity),
      /receipt is invalid/u,
    );

    const extraField = { ...receipt, controllerToken: "forbidden" };
    assert.throws(
      () => assertJsonSchema(extraField, schema),
      /JSON schema validation failed/u,
    );
    assert.throws(
      () => validateDiagnosticRetentionReceipt(extraField, identity),
      /receipt is invalid/u,
    );

    const privatePath = { ...receipt, storageKey: "/private/host/path" };
    assert.throws(
      () => assertJsonSchema(privatePath, schema),
      /JSON schema validation failed/u,
    );
    assert.throws(
      () => validateDiagnosticRetentionReceipt(privatePath, identity),
      /receipt is invalid/u,
    );
  } finally {
    fixture.cleanup();
  }
});

function diagnosticFixture({
  createSource = true,
  runnerContents = "runner diagnostic",
  unknownEntry = false,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "forge3d-runner-diag-"));
  const source = join(root, "job", "runner", "_diag");
  const destination = join(root, "protected", storageKey);
  if (createSource) {
    mkdirSync(source, { recursive: true });
    mkdirSync(join(root, "protected"), { recursive: true });
    writeFileSync(join(source, "Runner_20260729-100000.log"), runnerContents);
    writeFileSync(
      join(source, "Worker_20260729-100001.log"),
      "worker diagnostic",
    );
    if (unknownEntry) writeFileSync(join(source, "unknown.txt"), "unknown");
  }
  return {
    source,
    destination,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function captureError(action) {
  try {
    action();
  } catch (error) {
    return error;
  }
  assert.fail("expected action to throw");
}
