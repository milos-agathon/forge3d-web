import {
  CLEANUP_PROTOCOL_VERSION,
  FIXED_REPOSITORY,
  deriveJitRequest,
  validateCleanupRequest,
  validateJitRequest,
  validateRunnerIdentity,
  verifyControllerRequest,
  verifyReturnedRunner,
} from "./protocol.mjs";

const terminalStates = new Set([
  "deleted",
  "already_absent",
  "quarantined",
]);
const CANCELLATION_POLL_ATTEMPTS = 30;
const CANCELLATION_POLL_INTERVAL_MS = 1_000;

export class BrowserLabBroker {
  constructor({
    matrix,
    browserPolicy,
    ledger,
    authorizationVerifier,
    github,
    now = () => new Date(),
    sleep = wait,
    cancellationPollAttempts = CANCELLATION_POLL_ATTEMPTS,
    cancellationPollIntervalMs = CANCELLATION_POLL_INTERVAL_MS,
    provisioningMode = "active",
  }) {
    this.matrix = matrix;
    this.browserPolicy = browserPolicy;
    this.ledger = ledger;
    this.authorizationVerifier = authorizationVerifier;
    this.github = github;
    this.now = now;
    this.sleep = sleep;
    this.cancellationPollAttempts = cancellationPollAttempts;
    this.cancellationPollIntervalMs = cancellationPollIntervalMs;
    if (!["active", "initial-host-canary"].includes(provisioningMode)) {
      throw new Error("broker provisioning mode is invalid");
    }
    this.provisioningMode = provisioningMode;
  }

  async issueJitConfig(request, { mtlsIdentity }) {
    validateJitRequest(request);
    if (this.ledger.get(request.authorizationDigest)) {
      throw new Error("authorization already has a broker issuance record");
    }
    this.ledger.reserveRequestNonce(request.requestNonce);
    const authorization = await this.authorizationVerifier.verify({
      digest: request.authorizationDigest,
      controllerAssetId: request.controller.assetId,
      mode: "issuance",
    });
    this.assertIssuanceAllowed(authorization);
    const host = verifyControllerRequest({
      request,
      matrix: this.matrix,
      mtlsIdentity,
      expectedHostAssetId: authorization.hostAssetId,
    });
    this.verifyAuthorization(authorization);
    this.assertHostNotQuarantined(host.assetId);
    const derived = deriveJitRequest(authorization, host);
    const response = await this.github.generateJitConfig(derived);
    const issued = verifyReturnedRunner(response, derived);
    const issuedAt = this.now();
    const authorizationExpiry = new Date(authorization.expiresAt);
    const startDeadline = new Date(
      Math.min(
        authorizationExpiry.getTime(),
        issuedAt.getTime() + 2 * 60 * 1000,
      ),
    );
    try {
      this.ledger.create({
        schemaVersion: 1,
        protocolVersion: this.browserPolicy.brokerProtocolVersion,
        authorizationDigest: request.authorizationDigest,
        runId: authorization.runId,
        jobId: authorization.jobId,
        targetSha: authorization.targetSha,
        hostAssetId: host.assetId,
        controllerIdentity: host.controller.identity,
        runnerId: issued.runnerId,
        runnerName: issued.runnerName,
        customLabels: derived.labels,
        workFolder: derived.work_folder,
        state: "issued",
        issuedAt: issuedAt.toISOString(),
        authorizationExpiresAt: authorizationExpiry.toISOString(),
        startDeadline: startDeadline.toISOString(),
        onlineAt: null,
        assignmentDeadline: null,
        everOnline: false,
        everBusy: false,
        lastRunnerObservation: null,
        lastJobObservation: { status: authorization.jobStatus },
        localStopEvidence: null,
        workRootWipeEvidence: null,
        deletionResult: null,
        cancellationResult: null,
        cancellationRequestedAt: null,
        quarantineRequired: false,
        controllerUnreachableAt: null,
        quarantinedAt: null,
        quarantineReleasedAt: null,
        cleanupDecision: null,
      });
    } catch (error) {
      const runner = await this.github.getRunner(issued.runnerId);
      if (runner && runner.busy === false) {
        await this.github.deleteRunner(issued.runnerId);
      }
      throw new Error(`broker could not persist issuance ledger: ${error.message}`);
    }
    return {
      protocolVersion: this.browserPolicy.brokerProtocolVersion,
      authorizationDigest: request.authorizationDigest,
      runnerId: issued.runnerId,
      runnerName: issued.runnerName,
      encodedJitConfig: issued.encodedJitConfig,
      startDeadline: startDeadline.toISOString(),
    };
  }

  assertIssuanceAllowed(authorization) {
    if (
      this.provisioningMode === "initial-host-canary" &&
      (authorization.lane !== "infrastructure-canary" ||
        authorization.hasLabReadiness !== false ||
        authorization.hasManualSession !== false)
    ) {
      throw new Error(
        "initial host-canary mode accepts only non-manual infrastructure-canary authorization",
      );
    }
  }

  async cleanupRunner(request, { mtlsIdentity }) {
    validateCleanupRequest(request);
    this.ledger.reserveRequestNonce(request.requestNonce);
    const record = this.requireRecord(request.authorizationDigest);
    const authorization = await this.authorizationVerifier.verify({
      digest: request.authorizationDigest,
      controllerAssetId: request.controller.assetId,
      mode: "cleanup",
    });
    if (
      authorization.runId !== record.runId ||
      authorization.jobId !== record.jobId ||
      authorization.targetSha !== record.targetSha ||
      authorization.hostAssetId !== record.hostAssetId
    ) {
      throw new Error("cleanup authorization disagrees with issuance ledger");
    }
    verifyControllerRequest({
      request,
      matrix: this.matrix,
      mtlsIdentity,
      expectedHostAssetId: record.hostAssetId,
    });
    const cleaned =
      request.reason === "quarantine-release"
        ? await this.releaseHostQuarantine(
            record,
            request.listenerStop,
            request.workRootWipe,
          )
        : await this.performCleanup(
            record,
            request.reason,
            request.listenerStop,
          );
    return cleanupResponse(cleaned);
  }

  async watchdogTick(digest, { controllerReachable = true } = {}) {
    let record = this.requireRecord(digest);
    if (record.cancellationResult === "pending") {
      return this.completePendingCancellation(record, {
        pollUntilTerminal: false,
      });
    }
    if (terminalStates.has(record.state)) return record;
    const [runner, job] = await Promise.all([
      this.github.getRunner(record.runnerId),
      this.github.getJob(record.jobId),
    ]);
    const now = this.now();
    const controllerLoss = controllerLossChanges(
      record,
      controllerReachable,
      now,
    );
    if (Object.keys(controllerLoss).length > 0) {
      record = this.ledger.update(digest, controllerLoss);
    }
    const jobObservation = summarizeJob(job, now);
    if (!runner) {
      const absent = this.ledger.update(digest, {
        lastRunnerObservation: {
          absent: true,
          observedAt: now.toISOString(),
        },
        lastJobObservation: jobObservation,
      });
      if (job.status === "completed") {
        const terminal = this.ledger.update(digest, {
          state: "terminal",
          lastRunnerObservation: absent.lastRunnerObservation,
          lastJobObservation: jobObservation,
        });
        return this.performCleanup(terminal, "terminal", null);
      }
      if (job.status === "in_progress") {
        return this.ledger.update(digest, {
          state: "busy",
          everBusy: true,
          lastRunnerObservation: absent.lastRunnerObservation,
          lastJobObservation: jobObservation,
        });
      }
      const startDeadlineElapsed =
        !absent.everOnline &&
        now.getTime() >= Date.parse(absent.startDeadline);
      const assignmentDeadlineElapsed =
        absent.assignmentDeadline !== null &&
        now.getTime() >= Date.parse(absent.assignmentDeadline);
      if (
        job.status === "queued" &&
        absent.quarantineRequired === true &&
        (startDeadlineElapsed || assignmentDeadlineElapsed)
      ) {
        const phase = absent.everOnline
          ? "assignment deadline"
          : "start deadline";
        return this.watchdogQuarantine(absent, { phase });
      }
      if (startDeadlineElapsed) {
        return this.ledger.update(digest, {
          state: "assignment_timeout",
          cleanupDecision:
            "runner absent at start deadline; awaiting authenticated cleanup or watchdog quarantine",
        });
      }
      return absent;
    }
    validateRunnerIdentity(runner, record);
    const runnerObservation = summarizeRunner(runner, now);
    if (job.status === "completed") {
      const terminal = this.ledger.update(digest, {
        state: "terminal",
        everOnline: record.everOnline || runner.status === "online",
        lastRunnerObservation: runnerObservation,
        lastJobObservation: jobObservation,
      });
      return this.performCleanup(terminal, "terminal", null);
    }
    if (runner.busy && job.status === "queued") {
      return this.ledger.update(digest, {
        state: "assigned",
        ...assignmentWindow(record, now),
        everOnline: true,
        everBusy: true,
        lastRunnerObservation: runnerObservation,
        lastJobObservation: jobObservation,
      });
    }
    if (job.status === "in_progress") {
      return this.ledger.update(digest, {
        state: "busy",
        ...assignmentWindow(record, now),
        everOnline: true,
        everBusy: true,
        lastRunnerObservation: runnerObservation,
        lastJobObservation: jobObservation,
      });
    }
    if (
      record.quarantineRequired === true &&
      record.assignmentDeadline !== null &&
      now.getTime() >= Date.parse(record.assignmentDeadline) &&
      runner.busy === false &&
      job.status === "queued"
    ) {
      const elapsed = this.ledger.update(digest, {
        lastRunnerObservation: runnerObservation,
        lastJobObservation: jobObservation,
      });
      return this.watchdogQuarantine(elapsed, {
        phase: "assignment deadline",
      });
    }
    if (runner.status === "online" && job.status === "queued") {
      const firstOnlineUnassigned = record.onlineAt === null;
      const { onlineAt, assignmentDeadline } = assignmentWindow(record, now);
      const updated = this.ledger.update(digest, {
        state: "online_unassigned",
        onlineAt,
        assignmentDeadline,
        everOnline: true,
        lastRunnerObservation: runnerObservation,
        lastJobObservation: jobObservation,
      });
      if (
        updated.quarantineRequired === true &&
        ((!record.everOnline &&
          now.getTime() >= Date.parse(record.startDeadline)) ||
          (!firstOnlineUnassigned &&
            now.getTime() >= Date.parse(assignmentDeadline)))
      ) {
        return this.watchdogQuarantine(updated, {
          phase: record.everOnline
            ? "assignment deadline"
            : "start deadline",
        });
      }
      return updated;
    }
    if (
      now.getTime() >= Date.parse(record.startDeadline) &&
      !record.everOnline
    ) {
      const timedOut = this.ledger.update(digest, {
        state: "assignment_timeout",
        lastRunnerObservation: runnerObservation,
        lastJobObservation: jobObservation,
      });
      if (timedOut.quarantineRequired === true && job.status === "queued") {
        return this.watchdogQuarantine(timedOut, {
          phase: "start deadline",
        });
      }
      return timedOut;
    }
    return this.ledger.update(digest, {
      lastRunnerObservation: runnerObservation,
      lastJobObservation: jobObservation,
    });
  }

  async performCleanup(record, reason, listenerStop) {
    if (record.cancellationResult === "pending") {
      return this.completePendingCancellation(record, {
        pollUntilTerminal: true,
      });
    }
    const [runner, job] = await Promise.all([
      this.github.getRunner(record.runnerId),
      this.github.getJob(record.jobId),
    ]);
    const now = this.now();
    const quarantineChanges = quarantineStateChanges(record, now);
    if (!runner) {
      if (reason === "online-unassigned") {
        const predicate = cleanupPredicate({
          reason,
          record,
          runner: null,
          job,
          listenerStop,
          now,
        });
        if (!predicate.allowed) throw new Error(predicate.reason);
        const pending = this.ledger.update(record.authorizationDigest, {
          state:
            record.quarantineRequired === true ? "quarantined" : "deleted",
          localStopEvidence: listenerStop,
          deletionResult: record.deletionResult ?? "already_absent",
          cancellationResult: "pending",
          ...quarantineChanges,
          cleanupDecision:
            `${predicate.reason}; exact runner already absent; exact queued run cancellation pending`,
        });
        return this.completePendingCancellation(pending, {
          pollUntilTerminal: true,
        });
      }
      return this.ledger.update(record.authorizationDigest, {
        state:
          record.quarantineRequired === true
            ? "quarantined"
            : "already_absent",
        localStopEvidence: listenerStop,
        deletionResult: "already_absent",
        ...quarantineChanges,
        cleanupDecision: `${reason}: runner already absent`,
      });
    }
    validateRunnerIdentity(runner, record);
    if (runner.busy) {
      throw new Error("busy runner cannot be deleted");
    }
    const predicate = cleanupPredicate({
      reason,
      record,
      runner,
      job,
      listenerStop,
      now,
    });
    if (!predicate.allowed) throw new Error(predicate.reason);
    await this.github.deleteRunner(record.runnerId);
    if (await this.github.getRunner(record.runnerId)) {
      throw new Error("exact runner ID still exists after deletion");
    }
    const deleted = this.ledger.update(record.authorizationDigest, {
      state: record.quarantineRequired === true ? "quarantined" : "deleted",
      localStopEvidence: listenerStop,
      deletionResult: "deleted",
      cancellationResult:
        reason === "online-unassigned" ? "pending" : null,
      ...quarantineChanges,
      cleanupDecision:
        reason === "online-unassigned"
          ? `${predicate.reason}; exact queued run cancellation pending`
          : predicate.reason,
    });
    if (reason === "online-unassigned") {
      return this.completePendingCancellation(deleted, {
        pollUntilTerminal: true,
      });
    }
    return deleted;
  }

  async watchdogQuarantine(record, { phase = "assignment deadline" } = {}) {
    const [runner, job] = await Promise.all([
      this.github.getRunner(record.runnerId),
      this.github.getJob(record.jobId),
    ]);
    if (job.status !== "queued" || runner?.busy) {
      throw new Error("watchdog cannot delete a busy runner or non-queued job");
    }
    let deletionResult = record.deletionResult ?? "already_absent";
    if (runner) {
      validateRunnerIdentity(runner, record);
      await this.github.deleteRunner(record.runnerId);
      if (await this.github.getRunner(record.runnerId)) {
        throw new Error("exact runner ID still exists after watchdog deletion");
      }
      deletionResult = "deleted";
    }
    const pending = this.ledger.update(record.authorizationDigest, {
      state: "quarantined",
      deletionResult,
      cancellationResult: "pending",
      quarantineRequired: true,
      controllerUnreachableAt:
        record.controllerUnreachableAt ?? this.now().toISOString(),
      quarantinedAt: record.quarantinedAt ?? this.now().toISOString(),
      cleanupDecision:
        `controller unreachable after ${phase}; exact runner deleted or absent; bound run cancellation pending; host quarantined`,
    });
    return this.completePendingCancellation(pending, {
      pollUntilTerminal: false,
    });
  }

  async completePendingCancellation(
    record,
    { pollUntilTerminal = false } = {},
  ) {
    let pending = record;
    let run = await this.github.getRun(record.runId);
    if (verifyCancelledRun(run, record.runId)) {
      return this.finalizeCancellation(pending);
    }
    if (
      pending.cancellationRequestedAt === null ||
      pending.cancellationRequestedAt === undefined
    ) {
      await this.github.cancelRun(record.runId);
      pending = this.ledger.update(record.authorizationDigest, {
        cancellationRequestedAt: this.now().toISOString(),
      });
      run = await this.github.getRun(record.runId);
      if (verifyCancelledRun(run, record.runId)) {
        return this.finalizeCancellation(pending);
      }
    }
    if (!pollUntilTerminal) return pending;
    for (
      let attempt = 0;
      attempt < this.cancellationPollAttempts;
      attempt += 1
    ) {
      await this.sleep(this.cancellationPollIntervalMs);
      run = await this.github.getRun(record.runId);
      if (verifyCancelledRun(run, record.runId)) {
        return this.finalizeCancellation(pending);
      }
    }
    throw new Error("bound workflow run cancellation remains pending");
  }

  finalizeCancellation(record) {
    return this.ledger.update(record.authorizationDigest, {
      state: record.state === "quarantined" ? "quarantined" : "deleted",
      cancellationResult: "cancelled",
      cleanupDecision: (record.cleanupDecision ??
        "exact bound run cancellation pending").replace(
        "cancellation pending",
        "cancellation completed",
      ),
    });
  }

  async releaseHostQuarantine(record, listenerStop, workRootWipe) {
    const now = this.now();
    if (
      record.state !== "quarantined" ||
      record.quarantineRequired !== true ||
      record.cancellationResult === "pending"
    ) {
      throw new Error("host does not have a releasable quarantine record");
    }
    const quarantineTime = Date.parse(record.quarantinedAt);
    if (
      listenerStop?.stopped !== true ||
      workRootWipe?.wiped !== true ||
      workRootWipe.workFolder !== record.workFolder ||
      !Number.isFinite(quarantineTime) ||
      Date.parse(listenerStop.observedAt) <= quarantineTime ||
      Date.parse(workRootWipe.observedAt) <= quarantineTime ||
      Date.parse(listenerStop.observedAt) > now.getTime() ||
      Date.parse(workRootWipe.observedAt) > now.getTime()
    ) {
      throw new Error(
        "quarantine release proof must postdate quarantine and prove listener stop plus exact work-root wipe",
      );
    }
    if (await this.github.getRunner(record.runnerId)) {
      throw new Error("quarantined runner must be absent before host release");
    }
    return this.ledger.update(record.authorizationDigest, {
      state:
        record.deletionResult === "deleted" ? "deleted" : "already_absent",
      localStopEvidence: listenerStop,
      workRootWipeEvidence: workRootWipe,
      quarantineRequired: false,
      quarantineReleasedAt: now.toISOString(),
      cleanupDecision:
        "authenticated controller proved listener stopped and exact work root wiped; host quarantine released",
    });
  }

  verifyAuthorization(authorization) {
    if (
      authorization.repository.id !== FIXED_REPOSITORY.id ||
      authorization.repository.fullName !== FIXED_REPOSITORY.fullName ||
      authorization.jobStatus !== "queued" ||
      !/^[0-9a-f]{40}$/u.test(authorization.targetSha ?? "") ||
      !Number.isInteger(authorization.runId) ||
      !Number.isInteger(authorization.jobId) ||
      Date.parse(authorization.expiresAt) <= this.now().getTime()
    ) {
      throw new Error("runner authorization is expired or not bound to a queued fixed-repository job");
    }
  }

  requireRecord(digest) {
    const record = this.ledger.get(digest);
    if (!record) throw new Error("authorization has no broker issuance record");
    return record;
  }

  assertHostNotQuarantined(hostAssetId) {
    const blocking = this.ledger.list().find(
      (record) =>
        record.hostAssetId === hostAssetId &&
        (record.quarantineRequired === true ||
          (record.state === "quarantined" &&
            (record.quarantineReleasedAt === null ||
              record.quarantineReleasedAt === undefined))),
    );
    if (blocking) {
      throw new Error(
        `host ${hostAssetId} is quarantined by issuance ${blocking.authorizationDigest}`,
      );
    }
  }
}

function cleanupPredicate({ reason, record, runner, job, listenerStop, now }) {
  if (reason === "terminal" && job.status === "completed") {
    return { allowed: true, reason: "authorized job is terminal" };
  }
  if (
    reason === "launch-failure" &&
    !record.everOnline &&
    now.getTime() < Date.parse(record.startDeadline)
  ) {
    return { allowed: true, reason: "signed launch failure before runner became online" };
  }
  if (
    reason === "start-timeout" &&
    !record.everOnline &&
    now.getTime() >= Date.parse(record.startDeadline)
  ) {
    return { allowed: true, reason: "runner did not become online before start deadline" };
  }
  if (
    reason === "online-unassigned" &&
    record.state === "online_unassigned" &&
    record.everBusy === false &&
    (runner === null || runner.busy === false) &&
    job.status === "queued" &&
    listenerStop?.attempted === true &&
    listenerStop.stopped === true &&
    now.getTime() >= Date.parse(record.assignmentDeadline)
  ) {
    return {
      allowed: true,
      reason:
        "listener stopped; exact runner remained non-busy and exact job remained queued at assignment deadline",
    };
  }
  return {
    allowed: false,
    reason: `${reason} cleanup predicate was not satisfied`,
  };
}

function cleanupResponse(record) {
  return {
    authorizationDigest: record.authorizationDigest,
    runnerId: record.runnerId,
    runnerName: record.runnerName,
    state: record.state,
    deletionResult: record.deletionResult,
    cancellationResult: record.cancellationResult,
    cleanupDecision: record.cleanupDecision,
  };
}

function summarizeRunner(runner, now) {
  return {
    id: runner.id,
    name: runner.name,
    status: runner.status,
    busy: runner.busy,
    observedAt: now.toISOString(),
  };
}

function summarizeJob(job, now) {
  return {
    id: job.id,
    status: job.status,
    conclusion: job.conclusion ?? null,
    observedAt: now.toISOString(),
  };
}

function assignmentWindow(record, now) {
  const onlineAt = record.onlineAt ?? now.toISOString();
  const assignmentDeadline =
    record.assignmentDeadline ??
    new Date(
      Math.min(
        Date.parse(record.authorizationExpiresAt),
        Date.parse(onlineAt) + 90 * 1000,
      ),
    ).toISOString();
  return { onlineAt, assignmentDeadline };
}

function controllerLossChanges(record, controllerReachable, now) {
  if (controllerReachable || record.quarantineRequired === true) return {};
  return {
    quarantineRequired: true,
    controllerUnreachableAt:
      record.controllerUnreachableAt ?? now.toISOString(),
  };
}

function quarantineStateChanges(record, now) {
  if (record.quarantineRequired !== true) return {};
  return {
    quarantineRequired: true,
    quarantinedAt: record.quarantinedAt ?? now.toISOString(),
  };
}

function verifyCancelledRun(run, runId) {
  if (run.id !== runId) {
    throw new Error("workflow run response does not match the ledger-bound run");
  }
  if (run.status !== "completed") return false;
  if (run.conclusion !== "cancelled") {
    throw new Error("ledger-bound workflow run completed without cancellation");
  }
  return true;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
