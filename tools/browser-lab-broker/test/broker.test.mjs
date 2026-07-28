import assert from "node:assert/strict";
import {
  createSign,
  generateKeyPairSync,
} from "node:crypto";
import test from "node:test";

import { BrowserLabBroker } from "../src/broker.mjs";
import { canonicalJson } from "../src/canonical-json.mjs";
import { MemoryLedger } from "../src/ledger.mjs";
import {
  BROKER_PROTOCOL_VERSION,
  CLEANUP_PROTOCOL_VERSION,
} from "../src/protocol.mjs";

const { privateKey, publicKey } = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
});
const publicJwk = publicKey.export({ format: "jwk" });
const controller = {
  assetId: "FW-LNX-NV-01",
  identity: "controller:FW-LNX-NV-01",
  signingKeyId: "controller-fw-lnx-nv-01-p256-v1",
};
const digest = "a".repeat(64);

test("derives one exact JIT runner and never persists encoded configuration", async () => {
  const context = makeContext();
  const response = await issue(context);
  assert.equal(response.runnerName, `FW-LNX-NV-01-${"b".repeat(32)}`);
  assert.equal(response.encodedJitConfig, "encoded-jit-config-secret");
  assert.deepEqual(context.github.generateCalls[0], {
    name: response.runnerName,
    runner_group_id: 1,
    work_folder: "_work",
    labels: [
      "forge3d-web",
      "hw-linux-rtx3070",
      `jit-${"b".repeat(32)}`,
    ],
  });
  const record = context.ledger.get(digest);
  assert.equal(record.state, "issued");
  assert.equal(record.workFolder, "_work");
  assert.equal(JSON.stringify(record).includes("encoded-jit-config-secret"), false);
  assert.equal(context.github.registrationTokenCalls, 0);
});

test("rejects request nonce and authorization replay before another JIT call", async () => {
  const context = makeContext();
  const request = makeJitRequest();
  await context.broker.issueJitConfig(request, {
    mtlsIdentity: controller.identity,
  });
  await assert.rejects(
    context.broker.issueJitConfig(request, {
      mtlsIdentity: controller.identity,
    }),
    /already has a broker issuance record|nonce was already used/u,
  );
  const newNonce = signRequest({
    ...unsigned(request),
    requestNonce: "c".repeat(32),
  });
  await assert.rejects(
    context.broker.issueJitConfig(newNonce, {
      mtlsIdentity: controller.identity,
    }),
    /already has a broker issuance record/u,
  );
  assert.equal(context.github.generateCalls.length, 1);
});

test("rejects controller signature, mTLS identity, and returned-label mismatch", async () => {
  const invalidSignature = makeContext();
  const request = makeJitRequest();
  request.signature.value = `${
    request.signature.value.startsWith("A") ? "B" : "A"
  }${request.signature.value.slice(1)}`;
  await assert.rejects(
    invalidSignature.broker.issueJitConfig(request, {
      mtlsIdentity: controller.identity,
    }),
    /signature is invalid/u,
  );

  const wrongMtls = makeContext();
  await assert.rejects(
    wrongMtls.broker.issueJitConfig(makeJitRequest("d".repeat(32)), {
      mtlsIdentity: "controller:FW-LNX-I12-01",
    }),
    /identities disagree/u,
  );

  const changedLabels = makeContext();
  changedLabels.github.extraLabels.push("caller-selected");
  await assert.rejects(
    changedLabels.broker.issueJitConfig(makeJitRequest("e".repeat(32)), {
      mtlsIdentity: controller.identity,
    }),
    /unexpected label/u,
  );
});

test("terminal cleanup deletes only the ledger runner without cancelling a run", async () => {
  const context = makeContext();
  await issue(context);
  context.github.job.status = "completed";
  context.github.job.conclusion = "success";
  const result = await context.broker.cleanupRunner(
    makeCleanupRequest({ reason: "terminal", nonce: "1".repeat(32) }),
    { mtlsIdentity: controller.identity },
  );
  assert.equal(result.state, "deleted");
  assert.deepEqual(context.github.deleteCalls, [1001]);
  assert.deepEqual(context.github.cancelCalls, []);
});

test("launch failure and start timeout use exact-ID cleanup before online", async () => {
  const launchFailure = makeContext();
  await issue(launchFailure);
  const launchResult = await launchFailure.broker.cleanupRunner(
    makeCleanupRequest({ reason: "launch-failure", nonce: "2".repeat(32) }),
    { mtlsIdentity: controller.identity },
  );
  assert.equal(launchResult.state, "deleted");

  const startTimeout = makeContext();
  await issue(startTimeout);
  startTimeout.advance(121_000);
  const timeoutResult = await startTimeout.broker.cleanupRunner(
    makeCleanupRequest({ reason: "start-timeout", nonce: "3".repeat(32) }),
    { mtlsIdentity: controller.identity },
  );
  assert.equal(timeoutResult.state, "deleted");
});

test("online-unassigned cleanup requires stopped listener and queued non-busy job", async () => {
  const context = makeContext();
  await issue(context);
  await context.broker.watchdogTick(digest);
  context.advance(91_000);
  const result = await context.broker.cleanupRunner(
    makeCleanupRequest({
      reason: "online-unassigned",
      nonce: "4".repeat(32),
      listenerStop: {
        attempted: true,
        stopped: true,
        processId: 1234,
        observedAt: context.now().toISOString(),
      },
    }),
    { mtlsIdentity: controller.identity },
  );
  assert.equal(result.state, "deleted");
  assert.equal(result.deletionResult, "deleted");
  assert.equal(result.cancellationResult, "cancelled");
  assert.deepEqual(context.github.deleteCalls, [1001]);
  assert.deepEqual(context.github.cancelCalls, [2001]);
});

test("busy or no-longer-queued controls permit neither deletion nor cancellation", async () => {
  const busy = makeContext();
  await issue(busy);
  await busy.broker.watchdogTick(digest);
  busy.advance(91_000);
  busy.github.runner.busy = true;
  await assert.rejects(
    busy.broker.cleanupRunner(
      makeCleanupRequest({
        reason: "online-unassigned",
        nonce: "5".repeat(32),
        listenerStop: stopProof(busy),
      }),
      { mtlsIdentity: controller.identity },
    ),
    /busy runner/u,
  );
  assert.deepEqual(busy.github.deleteCalls, []);
  assert.deepEqual(busy.github.cancelCalls, []);

  const assigned = makeContext();
  await issue(assigned);
  await assigned.broker.watchdogTick(digest);
  assigned.advance(91_000);
  assigned.github.job.status = "in_progress";
  await assert.rejects(
    assigned.broker.cleanupRunner(
      makeCleanupRequest({
        reason: "online-unassigned",
        nonce: "6".repeat(32),
        listenerStop: stopProof(assigned),
      }),
      { mtlsIdentity: controller.identity },
    ),
    /predicate was not satisfied/u,
  );
  assert.deepEqual(assigned.github.deleteCalls, []);
  assert.deepEqual(assigned.github.cancelCalls, []);
});

test("already-absent cleanup is idempotent and does not cancel another run", async () => {
  const context = makeContext();
  await issue(context);
  context.github.deleted = true;
  const result = await context.broker.cleanupRunner(
    makeCleanupRequest({ reason: "terminal", nonce: "7".repeat(32) }),
    { mtlsIdentity: controller.identity },
  );
  assert.equal(result.state, "already_absent");
  assert.deepEqual(context.github.deleteCalls, []);
  assert.deepEqual(context.github.cancelCalls, []);
});

test("retries bound-run cancellation after exact runner deletion", async () => {
  const context = makeContext();
  await issue(context);
  await context.broker.watchdogTick(digest);
  context.advance(91_000);
  context.github.failNextCancellation = true;
  await assert.rejects(
    context.broker.cleanupRunner(
      makeCleanupRequest({
        reason: "online-unassigned",
        nonce: "8".repeat(32),
        listenerStop: stopProof(context),
      }),
      { mtlsIdentity: controller.identity },
    ),
    /synthetic cancellation failure/u,
  );
  const pending = context.ledger.get(digest);
  assert.equal(pending.state, "assignment_timeout");
  assert.equal(pending.deletionResult, "deleted");
  assert.equal(context.github.deleted, true);

  const recovered = await context.broker.cleanupRunner(
    makeCleanupRequest({
      reason: "online-unassigned",
      nonce: "9".repeat(32),
      listenerStop: stopProof(context),
    }),
    { mtlsIdentity: controller.identity },
  );
  assert.equal(recovered.state, "deleted");
  assert.equal(recovered.cancellationResult, "cancelled");
});

test("watchdog severs exact runner/run and quarantines an unreachable controller", async () => {
  const context = makeContext();
  await issue(context);
  const online = await context.broker.watchdogTick(digest, {
    controllerReachable: false,
  });
  assert.equal(online.state, "online_unassigned");
  assert.equal(
    Date.parse(online.assignmentDeadline) - context.now().getTime(),
    90_000,
  );
  context.advance(91_000);
  const quarantined = await context.broker.watchdogTick(digest, {
    controllerReachable: false,
  });
  assert.equal(quarantined.state, "quarantined");
  assert.deepEqual(context.github.deleteCalls, [1001]);
  assert.deepEqual(context.github.cancelCalls, [2001]);
});

function makeContext() {
  let clock = new Date("2026-07-28T12:00:00.000Z");
  const now = () => new Date(clock);
  const ledger = new MemoryLedger();
  const github = new MockGitHub();
  const authorization = {
    schemaVersion: 1,
    repository: {
      id: 1259761852,
      fullName: "milos-agathon/forge3d-web",
    },
    operation: "run-hardware-job",
    targetSha: "f".repeat(40),
    runId: 2001,
    jobId: 3001,
    jobStatus: "queued",
    hostAssetId: controller.assetId,
    hwLabel: "hw-linux-rtx3070",
    runnerNonce: "b".repeat(32),
    expiresAt: "2026-07-28T12:30:00.000Z",
  };
  const authorizationVerifier = {
    async verify({ digest: supplied, controllerAssetId }) {
      assert.equal(supplied, digest);
      assert.equal(controllerAssetId, controller.assetId);
      return structuredClone(authorization);
    },
  };
  const matrix = {
    provisioningState: "active",
    hosts: [
      {
        assetId: controller.assetId,
        requiredLabels: ["forge3d-web", "hw-linux-rtx3070"],
        state: "active",
        controller: {
          identity: controller.identity,
          state: "online",
          signingKeyId: controller.signingKeyId,
          publicJwk,
        },
      },
    ],
  };
  const browserPolicy = {
    brokerProtocolVersion: BROKER_PROTOCOL_VERSION,
    cleanupProtocolVersion: CLEANUP_PROTOCOL_VERSION,
  };
  const broker = new BrowserLabBroker({
    matrix,
    browserPolicy,
    ledger,
    authorizationVerifier,
    github,
    now,
  });
  return {
    broker,
    ledger,
    github,
    now,
    advance(milliseconds) {
      clock = new Date(clock.getTime() + milliseconds);
    },
  };
}

async function issue(context) {
  return context.broker.issueJitConfig(makeJitRequest(), {
    mtlsIdentity: controller.identity,
  });
}

function makeJitRequest(nonce = "0".repeat(32)) {
  return signRequest({
    protocolVersion: BROKER_PROTOCOL_VERSION,
    authorizationDigest: digest,
    requestNonce: nonce,
    controller,
  });
}

function makeCleanupRequest({ reason, nonce, listenerStop = null }) {
  return signRequest({
    protocolVersion: CLEANUP_PROTOCOL_VERSION,
    authorizationDigest: digest,
    requestNonce: nonce,
    controller,
    reason,
    listenerStop,
  });
}

function signRequest(body) {
  const signature = createSign("sha256")
    .update(canonicalJson(body))
    .end()
    .sign(privateKey, "base64url");
  return {
    ...body,
    signature: {
      algorithm: "SHA256withECDSA",
      signingKeyId: controller.signingKeyId,
      value: signature,
    },
  };
}

function unsigned(request) {
  const value = structuredClone(request);
  delete value.signature;
  return value;
}

function stopProof(context) {
  return {
    attempted: true,
    stopped: true,
    processId: 1234,
    observedAt: context.now().toISOString(),
  };
}

class MockGitHub {
  constructor() {
    this.runner = null;
    this.job = {
      id: 3001,
      run_id: 2001,
      status: "queued",
      conclusion: null,
    };
    this.run = { id: 2001, status: "queued", conclusion: null };
    this.deleted = false;
    this.generateCalls = [];
    this.deleteCalls = [];
    this.cancelCalls = [];
    this.registrationTokenCalls = 0;
    this.extraLabels = ["self-hosted", "Linux", "X64"];
    this.failNextCancellation = false;
  }

  async generateJitConfig(body) {
    this.generateCalls.push(structuredClone(body));
    this.runner = {
      id: 1001,
      name: body.name,
      labels: [...body.labels, ...this.extraLabels],
      status: "online",
      busy: false,
    };
    return {
      status: 201,
      body: {
        encoded_jit_config: "encoded-jit-config-secret",
        runner: structuredClone(this.runner),
      },
    };
  }

  async getRunner(id) {
    assert.equal(id, 1001);
    return this.deleted ? null : structuredClone(this.runner);
  }

  async deleteRunner(id) {
    assert.equal(id, 1001);
    this.deleteCalls.push(id);
    this.deleted = true;
  }

  async getJob(id) {
    assert.equal(id, 3001);
    return structuredClone(this.job);
  }

  async cancelRun(id) {
    assert.equal(id, 2001);
    if (this.failNextCancellation) {
      this.failNextCancellation = false;
      throw new Error("synthetic cancellation failure");
    }
    this.cancelCalls.push(id);
    this.run = { id, status: "completed", conclusion: "cancelled" };
  }

  async getRun(id) {
    assert.equal(id, 2001);
    return structuredClone(this.run);
  }
}
