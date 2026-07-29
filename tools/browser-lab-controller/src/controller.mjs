import { createHash, randomBytes } from "node:crypto";

import { createHostLabCanary } from "./lab-canary.mjs";

export class BrowserLabController {
  constructor({ hostId, platform, dependencies, now = () => new Date() }) {
    if (!/^FW-(?:MAC|WIN|LNX)-[A-Z0-9-]+$/u.test(hostId ?? "")) {
      throw new Error("controller hostId is invalid");
    }
    if (!["darwin", "linux", "win32"].includes(platform)) {
      throw new Error(`controller platform is unsupported: ${platform}`);
    }
    this.hostId = hostId;
    this.platform = platform;
    this.dependencies = dependencies;
    this.now = now;
  }

  async execute(authorization) {
    validateAuthorization(authorization, this.hostId, this.now());
    const authorizationBytes = Buffer.from(canonicalJson(authorization));
    const authorizationDigest = sha256(authorizationBytes);
    const lock = await this.dependencies.acquireHostLock(this.hostId);
    if (!lock) {
      throw new Error(`host lock is already occupied: ${this.hostId}`);
    }

    let issued = null;
    let runnerProcess = null;
    let brokerClean = false;
    let workRootWiped = false;
    let hostCanaryInput = null;
    let controllerReceiptSha256 = null;
    try {
      const jobRoot = await this.dependencies.prepareJobRoot({
        hostId: this.hostId,
        runnerNonce: authorization.runnerNonce,
        workFolder: authorization.workFolder,
      });
      await this.dependencies.verifyRunnerDistribution({
        jobRoot,
        phase: "before",
      });
      const requestNonce = randomBytes(16).toString("hex");
      issued = await this.dependencies.broker.issue({
        authorizationDigest,
        requestNonce,
        controller: this.hostId,
        runId: authorization.run.id,
        jobId: authorization.queuedHardwareJob.id,
        runnerName: authorization.runnerName,
        customLabels: authorization.customLabels,
        workFolder: authorization.workFolder,
      });
      assertIssuedRunner(issued, authorization);
      const sensitiveConfiguration = Buffer.from(
        issued.encodedJitConfig,
        "utf8",
      );
      delete issued.encodedJitConfig;
      const command =
        this.platform === "win32" ? "run.cmd" : "./run.sh";
      const args = ["--jitconfig", sensitiveConfiguration.toString("utf8")];
      try {
        runnerProcess = await this.dependencies.spawnRunner({
          command,
          args,
          cwd: jobRoot.runnerDirectory,
          env: this.dependencies.runnerEnvironment(),
          echo: false,
          shell: false,
        });
      } finally {
        sensitiveConfiguration.fill(0);
        args[1] = "<scrubbed>";
      }

      const terminal = await this.dependencies.monitorOneJob({
        process: runnerProcess,
        authorization,
        runnerId: issued.runnerId,
        runnerName: issued.runnerName,
      });
      if (terminal.reason === "online_unassigned") {
        if (
          terminal.listenerStopped !== true ||
          terminal.jobStillQueued !== true ||
          terminal.runnerBusy !== false
        ) {
          throw new Error("online_unassigned cleanup lacks fail-closed predicates");
        }
      }
      await this.dependencies.stopRunner(runnerProcess);
      runnerProcess = null;
      await this.dependencies.forwardDiagnostics({
        jobRoot,
        authorizationDigest,
      });
      if (
        authorization.lane === "infrastructure-canary" &&
        authorization.manualSession === null
      ) {
        hostCanaryInput = await this.dependencies.readHostCanaryInput({
          jobRoot,
          authorization,
        });
      }
      await this.dependencies.verifyRunnerDistribution({
        jobRoot,
        phase: "after",
      });
      const cleanup = await this.dependencies.broker.cleanup({
        authorizationDigest,
        requestNonce: randomBytes(16).toString("hex"),
        reason: terminal.reason,
        listenerStop: terminal.listenerStopEvidence,
        workRootWipe: {
          attempted: false,
          wiped: false,
          workFolder: authorization.workFolder,
          observedAt: this.now().toISOString(),
        },
      });
      if (!["deleted", "already_absent"].includes(cleanup.deletionResult)) {
        throw new Error(`broker cleanup did not prove runner absence: ${cleanup.deletionResult}`);
      }
      if (
        terminal.reason === "online_unassigned" &&
        cleanup.cancellationResult !== "cancelled"
      ) {
        throw new Error("online_unassigned cleanup did not cancel the exact bound run");
      }
      brokerClean = true;
      if (hostCanaryInput) {
        const credentials = await this.dependencies.controllerSigningCredentials();
        const signedRecord = createHostLabCanary({
          authorization: {
            ...authorization,
            sha256: authorizationDigest,
          },
          ...hostCanaryInput,
          execution: {
            ...hostCanaryInput.execution,
            acceptedJobCount: 1,
            cleanupComplete: true,
            runnerId: issued.runnerId,
            runnerName: issued.runnerName,
            runnerAbsent: true,
          },
          privateKey: credentials.privateKey,
          signingKeyId: credentials.signingKeyId,
        });
        await this.dependencies.storeControllerReceipt({
          run: authorization.run,
          recordType: "host-lab-canary",
          signedRecord,
        });
        controllerReceiptSha256 = sha256(
          Buffer.from(canonicalJson(signedRecord)),
        );
      }
      await this.dependencies.wipeJobRoot(jobRoot);
      workRootWiped = true;
      return {
        ok: true,
        authorizationDigest,
        runnerId: issued.runnerId,
        runnerName: issued.runnerName,
        deletionResult: cleanup.deletionResult,
        cancellationResult: cleanup.cancellationResult ?? null,
        controllerReceiptSha256,
      };
    } catch (error) {
      if (runnerProcess) {
        await this.dependencies.stopRunner(runnerProcess).catch(() => undefined);
      }
      if (issued && !brokerClean) {
        const cleanup = await this.dependencies.broker
          .cleanup({
            authorizationDigest,
            requestNonce: randomBytes(16).toString("hex"),
            reason: "controller_failure",
            listenerStop: {
              attempted: true,
              stopped: true,
              processId: null,
              observedAt: this.now().toISOString(),
            },
            workRootWipe: {
              attempted: false,
              wiped: false,
              workFolder: authorization.workFolder,
              observedAt: this.now().toISOString(),
            },
          })
          .catch(() => null);
        brokerClean = ["deleted", "already_absent"].includes(
          cleanup?.deletionResult,
        );
      }
      if (!issued || brokerClean) {
        await this.dependencies.wipePreparedJobRoot(authorization.runnerNonce);
        workRootWiped = true;
      }
      throw error;
    } finally {
      let cleanupSucceeded = false;
      let cleanupError = null;
      try {
        await this.dependencies.cleanupHost({
          restoreUpdates: true,
          stopBrowser: true,
          stopDrivers: true,
          stopAppium: true,
          stopTunnels: true,
        });
        cleanupSucceeded = true;
      } catch (error) {
        cleanupError = error;
      } finally {
        authorizationBytes.fill(0);
      }
      if (cleanupSucceeded && (!issued || brokerClean) && workRootWiped) {
        await lock.release();
      } else {
        await this.dependencies.quarantineHost({
          hostId: this.hostId,
          authorizationDigest,
          reason:
            "runner absence, work-root wipe, or unconditional host cleanup was not proven",
        });
      }
      if (cleanupError) {
        throw cleanupError;
      }
    }
  }
}

export function validateAuthorization(authorization, hostId, now = new Date()) {
  if (
    authorization?.schemaVersion !== 1 ||
    authorization.repository?.id !== 1259761852 ||
    authorization.repository?.name !== "milos-agathon/forge3d-web" ||
    authorization.workflow?.path !==
      ".github/workflows/browser-hardware.yml" ||
    authorization.workflow?.ref !== "refs/heads/main" ||
    authorization.workflow?.event !== "workflow_dispatch"
  ) {
    throw new Error("authorization repository/workflow identity is invalid");
  }
  if (authorization.hostId !== hostId) {
    throw new Error("authorization is bound to a different controller host");
  }
  if (
    !Number.isInteger(authorization.run?.id) ||
    authorization.run.id < 1 ||
    !Number.isInteger(authorization.run?.attempt) ||
    authorization.run.attempt < 1 ||
    !Number.isInteger(authorization.queuedHardwareJob?.id) ||
    authorization.queuedHardwareJob.id < 1 ||
    authorization.queuedHardwareJob.name !==
      "Browser Hardware / Ephemeral Execution" ||
    authorization.queuedHardwareJob.status !== "queued" ||
    !/^[0-9a-f]{40}$/u.test(authorization.trustedSha ?? "") ||
    !/^[0-9a-f]{40}$/u.test(authorization.trustEpochSha ?? "") ||
    !/^[0-9a-f]{64}$/u.test(authorization.packageManifestSha256 ?? "")
  ) {
    throw new Error("authorization run, job, commit, or package binding is invalid");
  }
  if (
    !/^[0-9a-f]{32}$/u.test(authorization.runnerNonce ?? "") ||
    authorization.nonceLabel !== `jit-${authorization.runnerNonce}` ||
    authorization.runnerName !== `${hostId}-${authorization.runnerNonce}`
  ) {
    throw new Error("authorization runner nonce/name binding is invalid");
  }
  if (
    authorization.workFolder !== "_work" ||
    authorization.repositoryJitRunnerGroupId !== 1 ||
    !Array.isArray(authorization.customLabels) ||
    authorization.customLabels.length !== 3 ||
    authorization.customLabels[0] !== "forge3d-web" ||
    authorization.customLabels[1]?.startsWith("hw-") !== true ||
    authorization.customLabels[2] !== authorization.nonceLabel
  ) {
    throw new Error("authorization JIT routing contract is invalid");
  }
  if (
    new Date(authorization.issuedAt) > now ||
    new Date(authorization.expiresAt) <= now ||
    new Date(authorization.expiresAt) -
      new Date(authorization.issuedAt) !==
      10 * 60 * 1000
  ) {
    throw new Error("authorization is expired or has an invalid lifetime");
  }
  return authorization;
}

function assertIssuedRunner(issued, authorization) {
  if (
    !Number.isInteger(issued?.runnerId) ||
    issued.runnerId < 1 ||
    issued.runnerName !== authorization.runnerName ||
    typeof issued.encodedJitConfig !== "string" ||
    issued.encodedJitConfig.length < 1
  ) {
    throw new Error("broker returned a mismatched JIT runner");
  }
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
