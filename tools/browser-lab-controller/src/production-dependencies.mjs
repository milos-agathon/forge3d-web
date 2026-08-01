import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  dirname,
  join,
  relative,
  sep,
} from "node:path";

import {
  assertOwnedJobRoot,
  requiredAbsolute,
  safeChild,
} from "./controller-job-files.mjs";
import {
  readHostCanaryInput,
  readManualSessionInput,
} from "./controller-evidence-inputs.mjs";
import { acquireFileHostLock } from "./host-lock.mjs";
import { storeControllerReceipt } from "./controller-receipt-store.mjs";
import { retainRunnerDiagnostics } from "./diagnostic-retention.mjs";
import {
  monitorAuthorizedJob,
  sanitizedRunnerEnvironment,
  spawnRunner,
  stopRunner,
} from "./runner-execution.mjs";
import { assertControllerSigner } from "./controller-signing.mjs";

export function createProductionControllerDependencies({
  hostId,
  github,
  broker,
  lifecycleStore = null,
  configuration,
  platform = process.platform,
  runnerEnvironment,
  installationEvidence,
  controllerSigner,
  now = () => new Date(),
}) {
  if (
    !runnerEnvironment ||
    typeof runnerEnvironment !== "object" ||
    Array.isArray(runnerEnvironment)
  ) {
    throw new Error("loaded service environment is required for JIT runners");
  }
  if (typeof lifecycleStore?.get !== "function") {
    throw new Error("broker lifecycle store is required for JIT runners");
  }
  if (
    installationEvidence?.component !== "controller" ||
    installationEvidence.instanceId !== hostId
  ) {
    throw new Error("verified controller installation evidence is required");
  }
  assertControllerSigner(controllerSigner);
  const jobsRoot = requiredAbsolute(configuration.jobsRoot, "jobs root");
  const runnerTemplate = requiredAbsolute(
    configuration.runnerTemplate,
    "runner template",
  );
  const verifier = requiredAbsolute(
    configuration.runnerVerifier,
    "runner verifier",
  );
  const diagnosticsRoot = requiredAbsolute(
    configuration.diagnosticsRoot,
    "diagnostics root",
  );
  const diagnosticsRelation = relative(jobsRoot, diagnosticsRoot);
  if (
    diagnosticsRelation === "" ||
    (diagnosticsRelation !== ".." &&
      !diagnosticsRelation.startsWith(`..${sep}`))
  ) {
    throw new Error("diagnostics root must remain outside the jobs root");
  }
  const receiptDirectory = requiredAbsolute(
    configuration.receiptDirectory,
    "receipt directory",
  );
  const hostCleanupHelper = requiredAbsolute(
    configuration.hostCleanupHelper,
    "host cleanup helper",
  );
  const lockPath = requiredAbsolute(configuration.lockPath, "host lock");
  const quarantinePath = requiredAbsolute(
    configuration.quarantinePath,
    "quarantine state",
  );
  const windowsInteractiveSessionBridge =
    platform === "win32"
      ? requiredAbsolute(
          configuration.windowsInteractiveSessionBridge,
          "Windows interactive-session bridge",
        )
      : null;
  const unixInteractiveSessionBridge =
    platform === "darwin" || platform === "linux"
      ? requiredAbsolute(
          configuration.unixInteractiveSessionBridge,
          "Unix interactive-session bridge",
        )
      : null;
  if (
    platform === "win32" &&
    !/^[0-9a-f]{64}$/u.test(
      configuration.windowsInteractiveSessionBridgeSha256 ?? "",
    )
  ) {
    throw new Error("Windows interactive-session bridge digest is required");
  }
  if (
    (platform === "darwin" || platform === "linux") &&
    (!/^[0-9a-f]{64}$/u.test(
      configuration.unixInteractiveSessionBridgeSha256 ?? "",
    ) ||
      !/^[a-z_][a-z0-9_-]*$/u.test(
        configuration.interactiveSessionUser ?? "",
      ) ||
      configuration.interactiveSessionUser === "root")
  ) {
    throw new Error("Unix interactive-session bridge identity is required");
  }

  return {
    acquireHostLock: async (requestedHostId) => {
      if (requestedHostId !== hostId) {
        throw new Error("host lock request targets another controller");
      }
      return acquireFileHostLock(lockPath);
    },
    prepareJobRoot: async ({ runnerNonce, workFolder }) => {
      if (
        !/^[0-9a-f]{32}$/u.test(runnerNonce ?? "") ||
        workFolder !== "_work"
      ) {
        throw new Error("controller job root binding is invalid");
      }
      const jobDirectory = safeChild(jobsRoot, runnerNonce);
      const runnerDirectory = join(jobDirectory, "runner");
      if (existsSync(jobDirectory)) {
        throw new Error("controller job root already exists");
      }
      mkdirSync(jobDirectory, { recursive: false, mode: 0o700 });
      cpSync(runnerTemplate, runnerDirectory, {
        recursive: true,
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
      });
      return { jobDirectory, runnerDirectory };
    },
    verifyRunnerDistribution: async ({ jobRoot, phase }) => {
      const result = JSON.parse(
        execFileSync(
          verifier,
          ["--root", jobRoot.runnerDirectory, "--phase", phase],
          {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "inherit"],
          },
        ),
      );
      if (
        result.ok !== true ||
        result.phase !== phase ||
        result.root !== jobRoot.runnerDirectory
      ) {
        throw new Error(`runner distribution ${phase} verification failed`);
      }
      return result;
    },
    broker,
    spawnRunner: (request) =>
      spawnRunner({
        ...request,
        platform,
        interactiveSessionBridge:
          windowsInteractiveSessionBridge ?? unixInteractiveSessionBridge,
        interactiveSessionBridgeSha256:
          configuration.windowsInteractiveSessionBridgeSha256 ??
          configuration.unixInteractiveSessionBridgeSha256,
        interactiveSessionUser: configuration.interactiveSessionUser,
        jobsRoot,
      }),
    runnerEnvironment: () => sanitizedRunnerEnvironment(runnerEnvironment),
    monitorOneJob: ({
      process: runnerProcess,
      authorization,
      authorizationDigest,
      runnerId,
      runnerName,
    }) =>
      monitorAuthorizedJob({
        github,
        runnerProcess,
        authorization,
        brokerLifecycle: () =>
          lifecycleStore.get({
            authorizationDigest,
            runnerId,
            runnerName,
          }),
        now,
      }),
    stopRunner,
    forwardDiagnostics: async ({ jobRoot, authorizationDigest, authorization }) => {
      const source = join(jobRoot.runnerDirectory, "_diag");
      const storageKey =
        `${authorization.hostId}-${authorization.run.id}-` +
        `${authorization.run.attempt}-${authorizationDigest}`;
      const destination = safeChild(diagnosticsRoot, storageKey);
      return retainRunnerDiagnostics({
        source,
        destination,
        authorizationDigest,
        hostId: authorization.hostId,
        run: authorization.run,
        runnerNonce: authorization.runnerNonce,
        storageKey,
        now: now(),
      });
    },
    readHostCanaryInput: async (request) => readHostCanaryInput(request),
    readManualSessionInput: async (request) => readManualSessionInput(request),
    controllerSigner: async () => controllerSigner,
    controllerInstallationEvidence: async () =>
      structuredClone(installationEvidence),
    storeControllerReceipt: async ({ run, recordType, signedRecord }) =>
      storeControllerReceipt({
        directory: receiptDirectory,
        run,
        recordType,
        signedRecord,
      }),
    wipeJobRoot: async (jobRoot) => {
      assertOwnedJobRoot(jobsRoot, jobRoot.jobDirectory);
      rmSync(jobRoot.jobDirectory, { recursive: true, force: false });
    },
    wipePreparedJobRoot: async (runnerNonce) => {
      const jobDirectory = safeChild(jobsRoot, runnerNonce);
      if (existsSync(jobDirectory)) {
        rmSync(jobDirectory, { recursive: true, force: false });
      }
    },
    cleanupHost: async (request) => {
      const receipt = JSON.parse(
        execFileSync(
          hostCleanupHelper,
          ["cleanup", "--host-id", hostId, "--request-json", JSON.stringify(request)],
          {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "inherit"],
          },
        ),
      );
      validateHostCleanupReceipt(receipt, { hostId, request });
    },
    quarantineHost: async (record) => {
      mkdirSync(dirname(quarantinePath), {
        recursive: true,
        mode: 0o700,
      });
      writeFileSync(
        quarantinePath,
        `${JSON.stringify(
          {
            schemaVersion: 1,
            ...record,
            quarantinedAt: now().toISOString(),
          },
          null,
          2,
        )}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    },
  };
}

export function validateHostCleanupReceipt(receipt, { hostId, request }) {
  const requested = {
    restoreUpdates: "updatesRestored",
    stopBrowser: "browserStopped",
    stopDrivers: "driversStopped",
    stopAppium: "appiumStopped",
    stopTunnels: "tunnelsStopped",
  };
  const receiptKeys = Object.keys(receipt ?? {}).sort();
  const resultKeys = Object.keys(receipt?.results ?? {}).sort();
  const expectedReceiptKeys = [
    "cleanupComplete",
    "hostId",
    "results",
    "schemaVersion",
  ];
  const expectedResultKeys = Object.values(requested).sort();
  if (
    receiptKeys.length !== expectedReceiptKeys.length ||
    receiptKeys.some((key, index) => key !== expectedReceiptKeys[index]) ||
    receipt.schemaVersion !== 1 ||
    receipt.hostId !== hostId ||
    receipt.cleanupComplete !== true ||
    resultKeys.length !== expectedResultKeys.length ||
    resultKeys.some((key, index) => key !== expectedResultKeys[index]) ||
    Object.entries(requested).some(
      ([requestKey, resultKey]) =>
        request?.[requestKey] !== true || receipt.results[resultKey] !== true,
    ) ||
    Object.keys(request ?? {}).length !== Object.keys(requested).length
  ) {
    throw new Error("controller host cleanup helper did not prove cleanup");
  }
  return receipt;
}
