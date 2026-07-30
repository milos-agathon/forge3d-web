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

test("initial host-canary mode accepts only a host-bound canary", async () => {
  const product = makeContext({
    provisioningMode: "initial-host-canary",
    authorization: {
      lane: "chrome-linux-rtx3070",
      hasLabReadiness: true,
      hasManualSession: false,
    },
  });
  await assert.rejects(
    issue(product),
    /initial host-canary mode accepts only host-bound non-manual infrastructure-canary/u,
  );
  assert.deepEqual(product.github.generateCalls, []);

  const manual = makeContext({
    provisioningMode: "initial-host-canary",
    authorization: {
      lane: "infrastructure-canary",
      hasLabReadiness: false,
      hasManualSession: true,
    },
  });
  await assert.rejects(
    issue(manual),
    /initial host-canary mode accepts only host-bound non-manual infrastructure-canary/u,
  );
  assert.deepEqual(manual.github.generateCalls, []);

  const attachedAsset = makeContext({
    provisioningMode: "initial-host-canary",
    authorization: {
      lane: "infrastructure-canary",
      targetAssetId: "FW-AND-QCOM-01",
      hasLabReadiness: false,
      hasManualSession: false,
    },
  });
  await assert.rejects(
    issue(attachedAsset),
    /initial host-canary mode accepts only host-bound non-manual infrastructure-canary/u,
  );
  assert.deepEqual(attachedAsset.github.generateCalls, []);

  const hostCanary = makeContext({
    provisioningMode: "initial-host-canary",
    authorization: {
      lane: "infrastructure-canary",
      targetAssetId: controller.assetId,
      hasLabReadiness: false,
      hasManualSession: false,
    },
  });
  const response = await issue(hostCanary);
  assert.equal(response.runnerName, `FW-LNX-NV-01-${"b".repeat(32)}`);
  assert.equal(hostCanary.github.generateCalls.length, 1);
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
  assert.deepEqual(Object.keys(result).sort(), [
    "authorizationDigest",
    "cancellationResult",
    "cleanupDecision",
    "deletionResult",
    "runnerId",
    "runnerName",
    "state",
  ]);
  assert.equal("runId" in result, false);
  assert.deepEqual(context.github.deleteCalls, [1001]);
  assert.deepEqual(context.github.cancelCalls, []);
  assert.deepEqual(context.verificationModes, ["issuance", "cleanup"]);
});

test("watchdog exact-ID deletes a runner as soon as its job completes", async () => {
  const context = makeContext();
  await issue(context);
  context.github.job.status = "completed";
  context.github.job.conclusion = "success";
  const result = await context.broker.watchdogTick(digest);
  assert.equal(result.state, "deleted");
  assert.equal(result.deletionResult, "deleted");
  assert.deepEqual(context.github.deleteCalls, [1001]);
  assert.deepEqual(context.github.cancelCalls, []);
});

test("watchdog retries exact-ID deletion from a persisted terminal state", async () => {
  const context = makeContext();
  await issue(context);
  context.github.job.status = "completed";
  context.github.job.conclusion = "success";
  context.github.failNextDeletion = true;
  await assert.rejects(
    context.broker.watchdogTick(digest),
    /synthetic deletion failure/u,
  );
  assert.equal(context.ledger.get(digest).state, "terminal");
  const recovered = await context.broker.watchdogTick(digest);
  assert.equal(recovered.state, "deleted");
  assert.deepEqual(context.github.deleteCalls, [1001]);
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

test("absent runner cannot bypass the online-unassigned cleanup predicate", async () => {
  const context = makeContext();
  await issue(context);
  context.github.deleted = true;
  await assert.rejects(
    context.broker.cleanupRunner(
      makeCleanupRequest({
        reason: "online-unassigned",
        nonce: "a".repeat(32),
        listenerStop: stopProof(context),
      }),
      { mtlsIdentity: controller.identity },
    ),
    /online-unassigned cleanup predicate was not satisfied/u,
  );
  assert.equal(context.ledger.get(digest).state, "issued");
  assert.deepEqual(context.github.deleteCalls, []);
  assert.deepEqual(context.github.cancelCalls, []);
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
  assert.equal(pending.state, "deleted");
  assert.equal(pending.deletionResult, "deleted");
  assert.equal(pending.cancellationResult, "pending");
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

test("accepted cancellation advances once per watchdog cycle until terminal", async () => {
  const context = makeContext();
  await issue(context);
  await context.broker.watchdogTick(digest);
  context.advance(91_000);
  context.github.queuedRunReadsAfterCancel = 2;
  const first = await context.broker.watchdogTick(digest, {
    controllerReachable: false,
  });
  assert.equal(first.state, "quarantined");
  assert.equal(first.cancellationResult, "pending");
  assert.equal(context.sleepCalls.length, 0);
  const second = await context.broker.watchdogTick(digest);
  assert.equal(second.cancellationResult, "pending");
  const terminal = await context.broker.watchdogTick(digest);
  assert.equal(terminal.cancellationResult, "cancelled");
  assert.deepEqual(context.github.cancelCalls, [2001]);
  assert.ok(context.github.getRunCalls >= 4);
});

test("pending cancellation survives runner deletion and completes on a later tick", async () => {
  const context = makeContext();
  await issue(context);
  await context.broker.watchdogTick(digest);
  context.advance(91_000);
  context.github.queuedRunReadsAfterCancel = 100;
  await context.broker.watchdogTick(digest, {
    controllerReachable: false,
  });
  const pending = context.ledger.get(digest);
  assert.equal(pending.state, "quarantined");
  assert.equal(pending.deletionResult, "deleted");
  assert.equal(pending.cancellationResult, "pending");
  context.github.queuedRunReadsAfterCancel = 0;
  const recovered = await context.broker.watchdogTick(digest, {
    controllerReachable: false,
  });
  assert.equal(recovered.state, "quarantined");
  assert.equal(recovered.cancellationResult, "cancelled");
  assert.deepEqual(context.github.cancelCalls, [2001]);
});

test("early runner absence remains nonterminal until watchdog quarantine is decidable", async () => {
  const context = makeContext();
  await issue(context);
  context.github.deleted = true;
  const first = await context.broker.watchdogTick(digest, {
    controllerReachable: true,
  });
  assert.equal(first.state, "issued");
  assert.equal(first.lastRunnerObservation.absent, true);
  context.advance(121_000);
  const quarantined = await context.broker.watchdogTick(digest, {
    controllerReachable: false,
  });
  assert.equal(quarantined.state, "quarantined");
  assert.equal(quarantined.deletionResult, "already_absent");
  assert.equal(quarantined.cancellationResult, "cancelled");
  assert.deepEqual(context.github.deleteCalls, []);
  assert.deepEqual(context.github.cancelCalls, [2001]);
});

test("controller loss while busy remains quarantined after terminal cleanup", async () => {
  const context = makeContext();
  await issue(context);
  context.github.runner.busy = true;
  context.github.job.status = "in_progress";
  const busy = await context.broker.watchdogTick(digest, {
    controllerReachable: false,
  });
  assert.equal(busy.state, "busy");
  assert.equal(busy.quarantineRequired, true);
  assert.ok(busy.controllerUnreachableAt);
  context.github.runner.busy = false;
  context.github.job.status = "completed";
  context.github.job.conclusion = "success";
  const terminal = await context.broker.watchdogTick(digest, {
    controllerReachable: true,
  });
  assert.equal(terminal.state, "quarantined");
  assert.equal(terminal.quarantineRequired, true);
  assert.ok(terminal.quarantinedAt);
  assert.deepEqual(context.github.deleteCalls, [1001]);
  assert.deepEqual(context.github.cancelCalls, []);
});

test("quarantined host blocks new issuance until signed stop and wipe recovery", async () => {
  const context = makeContext();
  await issue(context);
  await context.broker.watchdogTick(digest);
  context.advance(91_000);
  const quarantined = await context.broker.watchdogTick(digest, {
    controllerReachable: false,
  });
  assert.equal(quarantined.state, "quarantined");
  assert.equal(quarantined.quarantineRequired, true);

  const nextDigest = "d".repeat(64);
  context.addAuthorization(nextDigest, {
    runId: 2002,
    jobId: 3002,
    runnerNonce: "c".repeat(32),
  });
  await assert.rejects(
    context.broker.issueJitConfig(
      makeJitRequest("e".repeat(32), nextDigest),
      { mtlsIdentity: controller.identity },
    ),
    /host .* is quarantined/u,
  );
  assert.equal(context.github.generateCalls.length, 1);

  await assert.rejects(
    context.broker.cleanupRunner(
      makeCleanupRequest({
        reason: "quarantine-release",
        nonce: "f".repeat(32),
        listenerStop: stopProof(context),
      }),
      { mtlsIdentity: controller.identity },
    ),
    /requires listener-stop and work-root-wipe proof/u,
  );
  const staleObservedAt = new Date(
    context.now().getTime() - 1_000,
  ).toISOString();
  await assert.rejects(
    context.broker.cleanupRunner(
      makeCleanupRequest({
        reason: "quarantine-release",
        nonce: "3".repeat(32),
        listenerStop: {
          ...stopProof(context),
          observedAt: staleObservedAt,
        },
        workRootWipe: {
          ...workRootWipeProof(context),
          observedAt: staleObservedAt,
        },
      }),
      { mtlsIdentity: controller.identity },
    ),
    /proof must postdate quarantine/u,
  );
  context.advance(1_000);
  const released = await context.broker.cleanupRunner(
    makeCleanupRequest({
      reason: "quarantine-release",
      nonce: "1".repeat(32),
      listenerStop: stopProof(context),
      workRootWipe: workRootWipeProof(context),
    }),
    { mtlsIdentity: controller.identity },
  );
  assert.equal(released.state, "deleted");
  const releasedRecord = context.ledger.get(digest);
  assert.equal(releasedRecord.quarantineRequired, false);
  assert.equal(releasedRecord.workRootWipeEvidence.wiped, true);
  assert.ok(releasedRecord.quarantineReleasedAt);

  await context.broker.issueJitConfig(
    makeJitRequest("2".repeat(32), nextDigest),
    { mtlsIdentity: controller.identity },
  );
  assert.equal(context.github.generateCalls.length, 2);
});

test("queued runner assignment is persisted separately from active work", async () => {
  const context = makeContext();
  await issue(context);
  context.github.runner.busy = true;
  context.github.job.status = "queued";
  const assigned = await context.broker.watchdogTick(digest);
  assert.equal(assigned.state, "assigned");
  assert.equal(
    Date.parse(assigned.assignmentDeadline) - context.now().getTime(),
    90_000,
  );
  context.github.job.status = "in_progress";
  const busy = await context.broker.watchdogTick(digest);
  assert.equal(busy.state, "busy");
});

test("first-observed assignment gets an escape deadline before disappearance", async () => {
  const context = makeContext();
  await issue(context);
  context.github.runner.busy = true;
  const assigned = await context.broker.watchdogTick(digest, {
    controllerReachable: false,
  });
  assert.equal(assigned.state, "assigned");
  assert.equal(
    Date.parse(assigned.assignmentDeadline) - context.now().getTime(),
    90_000,
  );
  context.advance(91_000);
  context.github.deleted = true;
  const quarantined = await context.broker.watchdogTick(digest, {
    controllerReachable: false,
  });
  assert.equal(quarantined.state, "quarantined");
  assert.equal(quarantined.deletionResult, "already_absent");
  assert.equal(quarantined.cancellationResult, "cancelled");
  assert.deepEqual(context.github.cancelCalls, [2001]);
});

test("first-observed active job gets an escape deadline before requeue", async () => {
  const context = makeContext();
  await issue(context);
  context.github.runner.busy = true;
  context.github.job.status = "in_progress";
  const busy = await context.broker.watchdogTick(digest, {
    controllerReachable: false,
  });
  assert.equal(busy.state, "busy");
  assert.equal(
    Date.parse(busy.assignmentDeadline) - context.now().getTime(),
    90_000,
  );
  context.advance(91_000);
  context.github.runner.busy = false;
  context.github.runner.status = "offline";
  context.github.job.status = "queued";
  const quarantined = await context.broker.watchdogTick(digest, {
    controllerReachable: false,
  });
  assert.equal(quarantined.state, "quarantined");
  assert.equal(quarantined.deletionResult, "deleted");
  assert.equal(quarantined.cancellationResult, "cancelled");
  assert.deepEqual(context.github.deleteCalls, [1001]);
  assert.deepEqual(context.github.cancelCalls, [2001]);
});

test("offline non-busy runner is quarantined after the assignment deadline", async () => {
  const context = makeContext();
  await issue(context);
  const online = await context.broker.watchdogTick(digest, {
    controllerReachable: false,
  });
  assert.equal(online.state, "online_unassigned");
  context.github.runner.status = "offline";
  context.advance(91_000);
  const quarantined = await context.broker.watchdogTick(digest, {
    controllerReachable: false,
  });
  assert.equal(quarantined.state, "quarantined");
  assert.equal(quarantined.cancellationResult, "cancelled");
  assert.deepEqual(context.github.deleteCalls, [1001]);
  assert.deepEqual(context.github.cancelCalls, [2001]);
});

test("re-queued assigned runner disappearance uses the persisted deadline", async () => {
  const context = makeContext();
  await issue(context);
  await context.broker.watchdogTick(digest, {
    controllerReachable: false,
  });
  context.github.runner.busy = true;
  const assigned = await context.broker.watchdogTick(digest, {
    controllerReachable: false,
  });
  assert.equal(assigned.state, "assigned");
  assert.ok(assigned.assignmentDeadline);
  context.advance(91_000);
  context.github.deleted = true;
  const quarantined = await context.broker.watchdogTick(digest, {
    controllerReachable: false,
  });
  assert.equal(quarantined.state, "quarantined");
  assert.equal(quarantined.deletionResult, "already_absent");
  assert.equal(quarantined.cancellationResult, "cancelled");
  assert.deepEqual(context.github.cancelCalls, [2001]);
});

test("re-queued busy runner offline uses the persisted deadline", async () => {
  const context = makeContext();
  await issue(context);
  await context.broker.watchdogTick(digest, {
    controllerReachable: false,
  });
  context.github.runner.busy = true;
  context.github.job.status = "in_progress";
  const busy = await context.broker.watchdogTick(digest, {
    controllerReachable: false,
  });
  assert.equal(busy.state, "busy");
  assert.ok(busy.assignmentDeadline);
  context.advance(91_000);
  context.github.runner.busy = false;
  context.github.runner.status = "offline";
  context.github.job.status = "queued";
  const quarantined = await context.broker.watchdogTick(digest, {
    controllerReachable: false,
  });
  assert.equal(quarantined.state, "quarantined");
  assert.equal(quarantined.deletionResult, "deleted");
  assert.equal(quarantined.cancellationResult, "cancelled");
  assert.deepEqual(context.github.deleteCalls, [1001]);
  assert.deepEqual(context.github.cancelCalls, [2001]);
});

test("unexpected live runner label fails closed before cleanup", async () => {
  const context = makeContext();
  await issue(context);
  context.github.runner.labels.push("unreviewed-routing-label");
  context.github.job.status = "completed";
  context.github.job.conclusion = "success";
  await assert.rejects(
    context.broker.watchdogTick(digest),
    /labels disagree with issuance ledger/u,
  );
  assert.deepEqual(context.github.deleteCalls, []);
  assert.deepEqual(context.github.cancelCalls, []);
});

test("watchdog never deletes an unassigned runner while its controller is reachable", async () => {
  const context = makeContext();
  await issue(context);
  await context.broker.watchdogTick(digest, {
    controllerReachable: true,
  });
  context.advance(91_000);
  const healthy = await context.broker.watchdogTick(digest, {
    controllerReachable: true,
  });
  assert.equal(healthy.state, "online_unassigned");
  assert.deepEqual(context.github.deleteCalls, []);
  assert.deepEqual(context.github.cancelCalls, []);
});

test("watchdog deletes, cancels, and quarantines when controller disappears before runner online", async () => {
  const context = makeContext();
  await issue(context);
  context.github.runner.status = "offline";
  context.advance(121_000);
  const reachable = await context.broker.watchdogTick(digest, {
    controllerReachable: true,
  });
  assert.equal(reachable.state, "assignment_timeout");
  assert.deepEqual(context.github.deleteCalls, []);
  const quarantined = await context.broker.watchdogTick(digest, {
    controllerReachable: false,
  });
  assert.equal(quarantined.state, "quarantined");
  assert.equal(quarantined.deletionResult, "deleted");
  assert.equal(quarantined.cancellationResult, "cancelled");
  assert.deepEqual(context.github.deleteCalls, [1001]);
  assert.deepEqual(context.github.cancelCalls, [2001]);
});

function makeContext({
  provisioningMode = "active",
  authorization: authorizationOverrides = {},
} = {}) {
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
    targetAssetId: controller.assetId,
    hostAssetId: controller.assetId,
    hwLabel: "hw-linux-rtx3070",
    runnerNonce: "b".repeat(32),
    expiresAt: "2026-07-28T12:30:00.000Z",
    lane: "chrome-linux-rtx3070",
    hasLabReadiness: true,
    hasManualSession: false,
    ...authorizationOverrides,
  };
  const authorizations = new Map([[digest, authorization]]);
  const verificationModes = [];
  const sleepCalls = [];
  const authorizationVerifier = {
    async verify({ digest: supplied, controllerAssetId, mode }) {
      assert.equal(controllerAssetId, controller.assetId);
      assert.ok(["issuance", "cleanup"].includes(mode));
      verificationModes.push(mode);
      const matched = authorizations.get(supplied);
      assert.ok(matched, `unexpected authorization digest ${supplied}`);
      return structuredClone(matched);
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
    sleep: async (milliseconds) => {
      sleepCalls.push(milliseconds);
    },
    cancellationPollAttempts: 3,
    cancellationPollIntervalMs: 1,
    provisioningMode,
  });
  return {
    broker,
    ledger,
    github,
    now,
    verificationModes,
    sleepCalls,
    addAuthorization(authorizationDigest, overrides = {}) {
      authorizations.set(authorizationDigest, {
        ...structuredClone(authorization),
        ...structuredClone(overrides),
      });
    },
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

function makeJitRequest(
  nonce = "0".repeat(32),
  authorizationDigest = digest,
) {
  return signRequest({
    protocolVersion: BROKER_PROTOCOL_VERSION,
    authorizationDigest,
    requestNonce: nonce,
    controller,
  });
}

function makeCleanupRequest({
  reason,
  nonce,
  listenerStop = null,
  workRootWipe = null,
}) {
  return signRequest({
    protocolVersion: CLEANUP_PROTOCOL_VERSION,
    authorizationDigest: digest,
    requestNonce: nonce,
    controller,
    reason,
    listenerStop,
    workRootWipe,
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

function workRootWipeProof(context) {
  return {
    attempted: true,
    wiped: true,
    workFolder: "_work",
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
    this.failNextDeletion = false;
    this.failNextCancellation = false;
    this.cancellationAccepted = false;
    this.queuedRunReadsAfterCancel = 0;
    this.getRunCalls = 0;
  }

  async generateJitConfig(body) {
    this.generateCalls.push(structuredClone(body));
    this.deleted = false;
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
    if (this.failNextDeletion) {
      this.failNextDeletion = false;
      throw new Error("synthetic deletion failure");
    }
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
    this.cancellationAccepted = true;
  }

  async getRun(id) {
    assert.equal(id, 2001);
    this.getRunCalls += 1;
    if (this.cancellationAccepted) {
      if (this.queuedRunReadsAfterCancel > 0) {
        this.queuedRunReadsAfterCancel -= 1;
      } else {
        this.run = { id, status: "completed", conclusion: "cancelled" };
      }
    }
    return structuredClone(this.run);
  }
}
