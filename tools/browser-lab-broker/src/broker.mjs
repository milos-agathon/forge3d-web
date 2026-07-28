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
  "terminal",
  "deleted",
  "already_absent",
  "quarantined",
]);

export class BrowserLabBroker {
  constructor({
    matrix,
    browserPolicy,
    ledger,
    authorizationVerifier,
    github,
    now = () => new Date(),
  }) {
    this.matrix = matrix;
    this.browserPolicy = browserPolicy;
    this.ledger = ledger;
    this.authorizationVerifier = authorizationVerifier;
    this.github = github;
    this.now = now;
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
    });
    const host = verifyControllerRequest({
      request,
      matrix: this.matrix,
      mtlsIdentity,
      expectedHostAssetId: authorization.hostAssetId,
    });
    this.verifyAuthorization(authorization);
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
        deletionResult: null,
        cancellationResult: null,
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

  async cleanupRunner(request, { mtlsIdentity }) {
    validateCleanupRequest(request);
    this.ledger.reserveRequestNonce(request.requestNonce);
    const record = this.requireRecord(request.authorizationDigest);
    const authorization = await this.authorizationVerifier.verify({
      digest: request.authorizationDigest,
      controllerAssetId: request.controller.assetId,
      allowExpired: true,
      allowRegisteredRunners: true,
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
    return this.performCleanup(record, request.reason, request.listenerStop);
  }

  async watchdogTick(digest, { controllerReachable = true } = {}) {
    const record = this.requireRecord(digest);
    if (terminalStates.has(record.state)) return record;
    const [runner, job] = await Promise.all([
      this.github.getRunner(record.runnerId),
      this.github.getJob(record.jobId),
    ]);
    const now = this.now();
    if (!runner) {
      return this.ledger.update(digest, {
        state: "already_absent",
        lastRunnerObservation: { absent: true, observedAt: now.toISOString() },
        lastJobObservation: summarizeJob(job, now),
        cleanupDecision: "runner already absent",
      });
    }
    validateRunnerIdentity(runner, record);
    const runnerObservation = summarizeRunner(runner, now);
    const jobObservation = summarizeJob(job, now);
    if (runner.busy || job.status === "in_progress") {
      return this.ledger.update(digest, {
        state: "busy",
        everOnline: true,
        everBusy: true,
        lastRunnerObservation: runnerObservation,
        lastJobObservation: jobObservation,
      });
    }
    if (job.status === "completed") {
      return this.ledger.update(digest, {
        state: "terminal",
        everOnline: record.everOnline || runner.status === "online",
        lastRunnerObservation: runnerObservation,
        lastJobObservation: jobObservation,
      });
    }
    if (runner.status === "online" && job.status === "queued") {
      const onlineAt = record.onlineAt ?? now.toISOString();
      const assignmentDeadline =
        record.assignmentDeadline ??
        new Date(
          Math.min(
            Date.parse(record.authorizationExpiresAt),
            Date.parse(onlineAt) + 90 * 1000,
          ),
        ).toISOString();
      const updated = this.ledger.update(digest, {
        state: "online_unassigned",
        onlineAt,
        assignmentDeadline,
        everOnline: true,
        lastRunnerObservation: runnerObservation,
        lastJobObservation: jobObservation,
      });
      if (
        !controllerReachable &&
        now.getTime() >= Date.parse(assignmentDeadline)
      ) {
        return this.watchdogQuarantine(updated);
      }
      return updated;
    }
    if (
      now.getTime() >= Date.parse(record.startDeadline) &&
      !record.everOnline
    ) {
      return this.ledger.update(digest, {
        state: "assignment_timeout",
        lastRunnerObservation: runnerObservation,
        lastJobObservation: jobObservation,
      });
    }
    return this.ledger.update(digest, {
      lastRunnerObservation: runnerObservation,
      lastJobObservation: jobObservation,
    });
  }

  async performCleanup(record, reason, listenerStop) {
    const [runner, job] = await Promise.all([
      this.github.getRunner(record.runnerId),
      this.github.getJob(record.jobId),
    ]);
    const now = this.now();
    if (!runner) {
      if (
        reason === "online-unassigned" &&
        job.status === "queued" &&
        listenerStop?.stopped === true
      ) {
        await this.cancelAndVerify(record.runId);
        return this.ledger.update(record.authorizationDigest, {
          state: "deleted",
          localStopEvidence: listenerStop,
          deletionResult: record.deletionResult ?? "already_absent",
          cancellationResult: "cancelled",
          cleanupDecision:
            "runner already absent; exact queued run cancellation completed",
        });
      }
      return this.ledger.update(record.authorizationDigest, {
        state: "already_absent",
        localStopEvidence: listenerStop,
        deletionResult: "already_absent",
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
    this.ledger.update(record.authorizationDigest, {
      state:
        reason === "online-unassigned" ? "assignment_timeout" : "deleted",
      localStopEvidence: listenerStop,
      deletionResult: "deleted",
      cleanupDecision: predicate.reason,
    });
    let cancellationResult = null;
    if (reason === "online-unassigned") {
      await this.cancelAndVerify(record.runId);
      cancellationResult = "cancelled";
    }
    return this.ledger.update(record.authorizationDigest, {
      state: "deleted",
      localStopEvidence: listenerStop,
      deletionResult: "deleted",
      cancellationResult,
      cleanupDecision: predicate.reason,
    });
  }

  async watchdogQuarantine(record) {
    const [runner, job] = await Promise.all([
      this.github.getRunner(record.runnerId),
      this.github.getJob(record.jobId),
    ]);
    if (!runner) {
      if (
        record.deletionResult === "deleted" &&
        record.cancellationResult !== "cancelled" &&
        job.status === "queued"
      ) {
        await this.cancelAndVerify(record.runId);
        return this.ledger.update(record.authorizationDigest, {
          state: "quarantined",
          cancellationResult: "cancelled",
          cleanupDecision:
            "runner previously deleted; exact queued run cancelled; host quarantined",
        });
      }
      return this.ledger.update(record.authorizationDigest, {
        state: "quarantined",
        deletionResult: "already_absent",
        cleanupDecision: "controller unreachable; runner absent; host quarantined",
      });
    }
    validateRunnerIdentity(runner, record);
    if (runner.busy || job.status !== "queued") {
      throw new Error("watchdog cannot delete a busy runner or non-queued job");
    }
    await this.github.deleteRunner(record.runnerId);
    this.ledger.update(record.authorizationDigest, {
      state: "assignment_timeout",
      deletionResult: "deleted",
      cleanupDecision:
        "controller unreachable; exact runner deleted; bound run cancellation pending",
    });
    await this.cancelAndVerify(record.runId);
    return this.ledger.update(record.authorizationDigest, {
      state: "quarantined",
      deletionResult: "deleted",
      cancellationResult: "cancelled",
      cleanupDecision:
        "controller unreachable after assignment deadline; exact runner/run severed; host quarantined",
    });
  }

  async cancelAndVerify(runId) {
    await this.github.cancelRun(runId);
    const run = await this.github.getRun(runId);
    if (run.status !== "completed" || run.conclusion !== "cancelled") {
      throw new Error("bound workflow run did not reach cancelled terminal state");
    }
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
    runner.busy === false &&
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
