import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

export async function spawnUnixRunner({
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
  controllerUid = process.getuid?.(),
  controllerGid = process.getgid?.(),
  execute = execFileSync,
}) {
  if (
    !["darwin", "linux"].includes(platform) ||
    command !== "./run.sh" ||
    !isAbsolute(interactiveSessionBridge ?? "") ||
    !isAbsolute(jobsRoot ?? "") ||
    !/^[0-9a-f]{64}$/u.test(interactiveSessionBridgeSha256 ?? "") ||
    !/^[a-z_][a-z0-9_-]*$/u.test(interactiveSessionUser ?? "") ||
    interactiveSessionUser === "root" ||
    !Number.isInteger(controllerUid) ||
    controllerUid < 1 ||
    !Number.isInteger(controllerGid) ||
    controllerGid < 1
  ) {
    throw noRunnerProcessError(
      "Unix runner requires a pinned interactive-session bridge",
    );
  }
  const bridgeBytes = readFile(interactiveSessionBridge);
  const actualDigest = createHash("sha256").update(bridgeBytes).digest("hex");
  if (actualDigest !== interactiveSessionBridgeSha256) {
    throw noRunnerProcessError(
      "Unix interactive-session bridge digest mismatch",
    );
  }
  const bridgeArguments = [
    "-n",
    interactiveSessionBridge,
    "--jobs-root",
    jobsRoot,
    "--expected-user",
    interactiveSessionUser,
    "--controller-uid",
    String(controllerUid),
    "--controller-gid",
    String(controllerGid),
  ];
  const child = spawnProcess("/usr/bin/sudo", bridgeArguments, {
    cwd,
    env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exit = childExit(child);
  const launch = readBridgeLaunch(child.stdout);
  child.stderr?.on("data", () => undefined);
  child.stdin?.on("error", () => undefined);
  child.stdin.end(
    JSON.stringify({
      schemaVersion: 1,
      command,
      arguments: args,
      workingDirectory: cwd,
      environment: env,
    }),
  );
  let receipt;
  try {
    receipt = await Promise.race([
      launch,
      exit.then(({ code, signal }) => {
        throw new Error(
          `Unix interactive-session bridge exited before launch: ${code ?? signal}`,
        );
      }),
    ]);
    if (receipt?.recordType === "launch_cleanup") {
      throw checkedLaunchCleanupError(receipt);
    }
    validateReceipt(receipt, { platform, interactiveSessionUser });
  } catch (error) {
    if (child.exitCode === null) child.kill();
    await waitForBridgeExit(exit);
    if (error?.runnerAbsenceProven !== true) {
      error.runnerAbsenceProven = false;
    }
    throw error;
  }
  child.stdout?.on("data", () => undefined);
  scrubSpawnArguments(child);
  return {
    pid: receipt.processId,
    bridgePid: child.pid,
    child,
    exit,
    stopped: false,
    platform,
    requiresCheckedProcessGroupAbsence: true,
    interactiveUser: receipt.interactiveUser,
    interactiveUid: receipt.interactiveUid,
    session: receipt.session,
    executionDomain: receipt.executionDomain,
    killTree: (processId, timeoutMs) =>
      stopRunnerGroup(processId, false, {
        execute,
        interactiveSessionBridge,
        jobsRoot,
        interactiveSessionUser,
        controllerUid,
        controllerGid,
        timeoutMs,
      }),
    forceKillTree: (processId, timeoutMs) =>
      stopRunnerGroup(processId, true, {
        execute,
        interactiveSessionBridge,
        jobsRoot,
        interactiveSessionUser,
        controllerUid,
        controllerGid,
        timeoutMs,
      }),
  };
}

function stopRunnerGroup(
  processId,
  force,
  {
    execute,
    interactiveSessionBridge,
    jobsRoot,
    interactiveSessionUser,
    controllerUid,
    controllerGid,
    timeoutMs,
  },
) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Unix runner stop timeout is invalid");
  }
  const bridgeArguments = [
    "-n",
    interactiveSessionBridge,
    "--stop",
    "--jobs-root",
    jobsRoot,
    "--expected-user",
    interactiveSessionUser,
    "--controller-uid",
    String(controllerUid),
    "--controller-gid",
    String(controllerGid),
    "--process-id",
    String(processId),
  ];
  if (force) bridgeArguments.push("--signal", "SIGKILL");
  bridgeArguments.push("--timeout-ms", String(timeoutMs));
  return execute("/usr/bin/sudo", bridgeArguments, {
    stdio: ["ignore", "ignore", "ignore"],
  });
}

function validateReceipt(receipt, { platform, interactiveSessionUser }) {
  const expectedType = platform === "linux" ? "wayland" : "aqua";
  const expectedDisplay =
    platform === "linux" ? /wayland/iu : /^WindowServer$/u;
  if (
    receipt?.schemaVersion !== 1 ||
    receipt.platform !== platform ||
    receipt.interactiveUser !== interactiveSessionUser ||
    !Number.isInteger(receipt.interactiveUid) ||
    receipt.interactiveUid < 1 ||
    !Number.isInteger(receipt.processId) ||
    receipt.processId < 1 ||
    receipt.session?.active !== true ||
    receipt.session?.locked !== false ||
    receipt.session?.remote !== false ||
    receipt.session?.type !== expectedType ||
    typeof receipt.session.identifier !== "string" ||
    receipt.session.identifier === "" ||
    !expectedDisplay.test(receipt.session.displayServer ?? "") ||
    receipt.executionDomain !==
      (platform === "linux"
        ? "systemd-user-manager"
        : `launchd-gui/${receipt.interactiveUid}`)
  ) {
    throw new Error("Unix interactive-session bridge receipt is invalid");
  }
}

function readBridgeLaunch(stdout) {
  return new Promise((resolvePromise, reject) => {
    let buffered = "";
    const cleanup = () => {
      stdout?.off("data", onData);
      stdout?.off("end", onEnd);
      stdout?.off("error", onEnd);
    };
    const onData = (chunk) => {
      buffered += chunk.toString("utf8");
      const newline = buffered.indexOf("\n");
      if (newline === -1) {
        if (buffered.length > 4096) {
          cleanup();
          reject(new Error("Unix interactive-session bridge receipt is too large"));
        }
        return;
      }
      cleanup();
      try {
        resolvePromise(JSON.parse(buffered.slice(0, newline).trim()));
      } catch {
        reject(new Error("Unix interactive-session bridge receipt is malformed"));
      }
    };
    const onEnd = () => {
      cleanup();
      reject(new Error("Unix interactive-session bridge returned no receipt"));
    };
    stdout?.on("data", onData);
    stdout?.once("end", onEnd);
    stdout?.once("error", onEnd);
  });
}

function childExit(child) {
  return new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      resolvePromise({ code, signal }),
    );
  });
}

function scrubSpawnArguments(child) {
  if (Array.isArray(child.spawnargs)) child.spawnargs.fill("<scrubbed>");
}

function noRunnerProcessError(message) {
  const error = new Error(message);
  error.runnerAbsenceProven = true;
  return error;
}

function checkedLaunchCleanupError(receipt) {
  if (
    receipt.schemaVersion !== 1 ||
    receipt.recordType !== "launch_cleanup" ||
    !Number.isInteger(receipt.processId) ||
    receipt.processId < 1 ||
    receipt.stopped !== true ||
    !Number.isFinite(Date.parse(receipt.observedAt))
  ) {
    const error = new Error(
      "Unix bridge launch cleanup receipt is invalid",
    );
    error.runnerAbsenceProven = false;
    return error;
  }
  const error = new Error(
    "Unix interactive-session bridge failed after starting the runner",
  );
  error.runnerAbsenceProven = true;
  error.listenerStopEvidence = {
    attempted: true,
    stopped: true,
    processId: receipt.processId,
    observedAt: receipt.observedAt,
  };
  return error;
}

async function waitForBridgeExit(exit, timeoutMs = 5_000) {
  let timer;
  try {
    const exited = await Promise.race([
      exit.then(() => true),
      new Promise((resolvePromise) => {
        timer = setTimeout(() => resolvePromise(false), timeoutMs);
      }),
    ]);
    if (!exited) {
      throw new Error("Unix launch bridge did not terminate after handshake failure");
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}
