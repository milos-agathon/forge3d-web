import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { win32 } from "node:path";

export async function spawnWindowsRunner({
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
}) {
  if (
    platform !== "win32" ||
    !win32.isAbsolute(interactiveSessionBridge ?? "") ||
    !win32.isAbsolute(jobsRoot ?? "") ||
    !/^[0-9a-f]{64}$/u.test(interactiveSessionBridgeSha256 ?? "")
  ) {
    throw noRunnerProcessError(
      "Windows runner requires a pinned interactive-session bridge",
    );
  }
  const bridgeBytes = readFile(interactiveSessionBridge);
  const actualDigest = createHash("sha256").update(bridgeBytes).digest("hex");
  if (actualDigest !== interactiveSessionBridgeSha256) {
    throw noRunnerProcessError(
      "Windows interactive-session bridge digest mismatch",
    );
  }
  const child = spawnProcess(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      interactiveSessionBridge,
      "-JobsRoot",
      jobsRoot,
    ],
    {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
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
          `Windows interactive-session bridge exited before launch: ${code ?? signal}`,
        );
      }),
    ]);
    if (receipt?.recordType === "launch_cleanup") {
      throw checkedLaunchCleanupError(receipt);
    }
    validateReceipt(receipt);
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
  const killTree = (processId) =>
    execFileSync(
      "taskkill.exe",
      ["/PID", String(processId), "/T", "/F"],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
  return {
    pid: receipt.processId,
    bridgePid: child.pid,
    child,
    exit,
    stopped: false,
    platform,
    consoleSessionId: receipt.consoleSessionId,
    desktop: receipt.desktop,
    killTree,
    forceKillTree: killTree,
  };
}

function readBridgeLaunch(stdout) {
  return new Promise((resolvePromise, reject) => {
    let buffered = "";
    const onData = (chunk) => {
      buffered += chunk.toString("utf8");
      const newline = buffered.indexOf("\n");
      if (newline === -1) {
        if (buffered.length > 4096) {
          cleanup();
          reject(new Error("Windows interactive-session bridge receipt is too large"));
        }
        return;
      }
      cleanup();
      try {
        resolvePromise(JSON.parse(buffered.slice(0, newline).trim()));
      } catch {
        reject(new Error("Windows interactive-session bridge receipt is malformed"));
      }
    };
    const onEnd = () => {
      cleanup();
      reject(new Error("Windows interactive-session bridge returned no receipt"));
    };
    const cleanup = () => {
      stdout?.off("data", onData);
      stdout?.off("end", onEnd);
      stdout?.off("error", onEnd);
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
  if (Array.isArray(child.spawnargs)) {
    child.spawnargs.fill("<scrubbed>");
  }
}

function validateReceipt(receipt) {
  if (
    receipt?.schemaVersion !== 1 ||
    !Number.isInteger(receipt.processId) ||
    receipt.processId < 1 ||
    !Number.isInteger(receipt.consoleSessionId) ||
    receipt.consoleSessionId < 1 ||
    receipt.desktop !== "winsta0\\default"
  ) {
    throw new Error("Windows interactive-session bridge receipt is invalid");
  }
}

function noRunnerProcessError(message) {
  const error = new Error(message);
  error.runnerAbsenceProven = true;
  return error;
}

function checkedLaunchCleanupError(receipt) {
  const processStarted = receipt?.processStarted;
  const processId = receipt?.processId;
  if (
    receipt?.schemaVersion !== 1 ||
    receipt.recordType !== "launch_cleanup" ||
    ![true, false].includes(processStarted) ||
    (processStarted &&
      (!Number.isInteger(processId) || processId < 1)) ||
    (!processStarted && processId !== null) ||
    receipt.stopped !== true ||
    !Number.isFinite(Date.parse(receipt.observedAt))
  ) {
    const error = new Error(
      "Windows bridge launch cleanup receipt is invalid",
    );
    error.runnerAbsenceProven = false;
    return error;
  }
  const error = new Error(
    "Windows interactive-session bridge failed during checked launch",
  );
  error.runnerAbsenceProven = true;
  if (processStarted) {
    error.listenerStopEvidence = {
      attempted: true,
      stopped: true,
      processId,
      observedAt: receipt.observedAt,
    };
  }
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
      throw new Error(
        "Windows launch bridge did not terminate after handshake failure",
      );
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}
