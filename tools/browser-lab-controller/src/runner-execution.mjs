import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

import { spawnUnixRunner } from "./unix-runner-execution.mjs";
import { spawnWindowsRunner } from "./windows-runner-execution.mjs";

export async function spawnRunner({
  command,
  args,
  cwd,
  env,
  shell,
  echo,
  platform = process.platform,
  interactiveSessionBridge = null,
  interactiveSessionBridgeSha256 = null,
  interactiveSessionUser = null,
  jobsRoot = null,
  spawnProcess = spawn,
  readFile = readFileSync,
  execute = undefined,
  controllerUid = process.getuid?.(),
  controllerGid = process.getgid?.(),
}) {
  if (
    shell !== false ||
    echo !== false ||
    !["./run.sh", "run.cmd"].includes(command) ||
    args?.length !== 2 ||
    args[0] !== "--jitconfig"
  ) {
    throw noRunnerProcessError("controller runner spawn contract is invalid");
  }
  if (command === "run.cmd") {
    return spawnWindowsRunner({
      command,
      args,
      cwd,
      env,
      platform,
      interactiveSessionBridge,
      interactiveSessionBridgeSha256,
      jobsRoot,
      spawnProcess,
      readFile,
    });
  }
  if (platform === "win32") {
    throw noRunnerProcessError(
      "Windows controller cannot launch a Unix runner entrypoint",
    );
  }
  return spawnUnixRunner({
    command,
    args,
    cwd,
    env,
    platform,
    interactiveSessionBridge,
    interactiveSessionBridgeSha256,
    interactiveSessionUser,
    jobsRoot,
    spawnProcess,
    readFile,
    execute,
    controllerUid,
    controllerGid,
  });
}

function noRunnerProcessError(message) {
  const error = new Error(message);
  error.runnerAbsenceProven = true;
  return error;
}

export async function monitorAuthorizedJob({
  github,
  runnerProcess,
  authorization,
  brokerLifecycle = () => null,
  now,
  runnerExitPollMs = 1_000,
}) {
  let assigned = false;
  for (;;) {
    const job = await github.getJob(authorization.queuedHardwareJob.id);
    if (job.id !== authorization.queuedHardwareJob.id) {
      throw new Error("controller job poll returned a different job");
    }
    if (job.status === "in_progress") assigned = true;
    const lifecycle = await brokerLifecycle();
    if (
      lifecycle?.everBusy === true ||
      ["assigned", "busy"].includes(lifecycle?.state)
    ) {
      assigned = true;
    }
    if (job.status === "completed") {
      const terminal = await withTimeout(runnerProcess.exit, 30_000, null);
      if (!terminal) {
        await stopRunner(runnerProcess);
      }
      return {
        reason: "terminal",
        listenerStopEvidence: stopEvidence(runnerProcess, now()),
      };
    }
    if (
      !assigned &&
      job.status === "queued" &&
      brokerObservedAssignmentTimeout(
        lifecycle,
        authorization.queuedHardwareJob.id,
        now(),
      )
    ) {
      const confirmed = await github.getJob(authorization.queuedHardwareJob.id);
      const confirmedLifecycle = await brokerLifecycle();
      if (
        confirmed.id !== authorization.queuedHardwareJob.id ||
        confirmed.status !== "queued" ||
        !brokerObservedAssignmentTimeout(
          confirmedLifecycle,
          authorization.queuedHardwareJob.id,
          now(),
        )
      ) {
        continue;
      }
      await stopRunner(runnerProcess);
      return {
        reason: "online_unassigned",
        listenerStopped: runnerProcess.stopped === true,
        jobStillQueued: true,
        runnerBusy: confirmedLifecycle.lastRunnerObservation.busy,
        listenerStopEvidence: stopEvidence(runnerProcess, now()),
      };
    }
    const exited = await withTimeout(
      runnerProcess.exit.then(() => true),
      runnerExitPollMs,
      false,
    );
    if (exited && job.status !== "completed") {
      return {
        reason: "launch_failure",
        listenerStopEvidence: stopEvidence(runnerProcess, now()),
      };
    }
  }
}

function brokerObservedAssignmentTimeout(lifecycle, jobId, observedAt) {
  const deadline = Date.parse(lifecycle?.assignmentDeadline);
  const runnerObservedAt = Date.parse(
    lifecycle?.lastRunnerObservation?.observedAt,
  );
  const jobObservedAt = Date.parse(lifecycle?.lastJobObservation?.observedAt);
  return (
    lifecycle?.state === "online_unassigned" &&
    lifecycle.everBusy === false &&
    Number.isFinite(deadline) &&
    observedAt.getTime() >= deadline &&
    lifecycle.lastRunnerObservation?.status === "online" &&
    lifecycle.lastRunnerObservation.busy === false &&
    Number.isFinite(runnerObservedAt) &&
    runnerObservedAt >= deadline &&
    lifecycle.lastJobObservation?.id === jobId &&
    lifecycle.lastJobObservation.status === "queued" &&
    Number.isFinite(jobObservedAt) &&
    jobObservedAt >= deadline
  );
}

export async function stopRunner(
  runnerProcess,
  {
    gracefulTimeoutMs = 30_000,
    forceTimeoutMs = 5_000,
  } = {},
) {
  if (!runnerProcess || runnerProcess.stopped) return;
  if (
    !Number.isInteger(gracefulTimeoutMs) ||
    gracefulTimeoutMs < 1 ||
    !Number.isInteger(forceTimeoutMs) ||
    forceTimeoutMs < 1
  ) {
    throw new Error("runner stop timeout contract is invalid");
  }
  if (runnerProcess.requiresCheckedProcessGroupAbsence === true) {
    try {
      await signalRunner(runnerProcess, "SIGTERM", gracefulTimeoutMs);
    } catch (gracefulError) {
      try {
        await signalRunner(runnerProcess, "SIGKILL", forceTimeoutMs);
      } catch (forceError) {
        runnerProcess.cleanupFailed = true;
        throw new Error("checked runner process-group cleanup failed", {
          cause: new AggregateError([gracefulError, forceError]),
        });
      }
    }
    runnerProcess.stopped = true;
    return;
  }
  if (runnerProcess.child.exitCode === null) {
    await signalRunner(runnerProcess, "SIGTERM");
    const exited = await withTimeout(
      runnerProcess.exit.then(() => true),
      gracefulTimeoutMs,
      false,
    );
    if (!exited) {
      try {
        await signalRunner(runnerProcess, "SIGKILL");
      } catch (error) {
        await withTimeout(
          runnerProcess.exit.then(() => true),
          forceTimeoutMs,
          false,
        );
        runnerProcess.cleanupFailed = true;
        throw new Error("checked runner force-kill operation failed", {
          cause: error,
        });
      }
      const forceExited = await withTimeout(
        runnerProcess.exit.then(() => true),
        forceTimeoutMs,
        false,
      );
      if (!forceExited) {
        runnerProcess.cleanupFailed = true;
        throw new Error(
          "runner process group did not exit after checked force kill",
        );
      }
    }
  }
  runnerProcess.stopped = true;
}

function signalRunner(runnerProcess, signal, timeoutMs) {
  let result;
  if (signal === "SIGKILL" && typeof runnerProcess.forceKillTree === "function") {
    result = runnerProcess.forceKillTree(runnerProcess.pid, timeoutMs);
  } else if (signal === "SIGTERM" && typeof runnerProcess.killTree === "function") {
    result = runnerProcess.killTree(runnerProcess.pid, timeoutMs);
  } else if (typeof runnerProcess.killTree === "function") {
    throw new Error("runner process has no checked force-kill operation");
  } else {
    result = runnerProcess.child.kill(signal);
  }
  if (result === false) {
    throw new Error(`runner process rejected ${signal}`);
  }
}

export function sanitizedRunnerEnvironment(environment) {
  const fixed = new Set([
    "PATH",
    "HOME",
    "USERPROFILE",
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "PATHEXT",
    "TMP",
    "TEMP",
    "TMPDIR",
    "LANG",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XDG_RUNTIME_DIR",
    "XDG_SESSION_ID",
    "XDG_SESSION_TYPE",
  ]);
  const prefixes = [
    "FORGE3D_BROWSER_",
    "FORGE3D_UPDATE_",
    "FORGE3D_PLAYWRIGHT_",
    "FORGE3D_GECKODRIVER_",
    "FORGE3D_APPIUM_",
    "FORGE3D_DEVICE_",
    "FORGE3D_CLOUDFLARED_",
    "FORGE3D_WDA_",
  ];
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) =>
        fixed.has(name) || prefixes.some((prefix) => name.startsWith(prefix)),
    ),
  );
}

function stopEvidence(runnerProcess, observedAt) {
  return {
    attempted: true,
    stopped: runnerProcess.stopped === true,
    processId: runnerProcess.pid,
    observedAt: observedAt.toISOString(),
  };
}

function delay(milliseconds) {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}

async function withTimeout(promise, milliseconds, timeoutValue) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolvePromise) => {
        timer = setTimeout(() => resolvePromise(timeoutValue), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
