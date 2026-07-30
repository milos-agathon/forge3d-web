#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const bridgePath = fileURLToPath(import.meta.url);
const contractPath = join(dirname(bridgePath), "unix-interactive-session-contract.mjs");
const contractSha256 = "4e2cd22608c9ff728a853c2495a2e30cfa462a58d26b012def7866721b44cc41";
const transientPathsModule = join(
  dirname(bridgePath),
  "unix-runner-transient-paths.mjs",
);
const transientPathsSha256 =
  "3f6f72e9a8084e4352d53ff68410e6943bea19c048ced5ffd766d9f904e03ce3";

async function loadContract() {
  return loadPinnedModule(
    contractPath,
    contractSha256,
    "Unix interactive-session contract",
  );
}

async function loadTransientPaths() {
  return loadPinnedModule(
    transientPathsModule,
    transientPathsSha256,
    "Unix runner transient-path contract",
  );
}

async function loadPinnedModule(path, expectedDigest, label) {
  const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (actual !== expectedDigest) throw new Error(`${label} digest mismatch`);
  return import(pathToFileURL(path).href);
}

async function launchRootBridge(options) {
  assertRootInvocation(options);
  const request = validateRequest(await readStandardInput(), options.jobsRoot);
  const contract = await loadContract();
  const transientPaths = await loadTransientPaths();
  const discovered = contract.discoverInteractiveSession(
    process.platform,
    options.expectedUser,
  );
  if (
    discovered.interactiveUid === options.controllerUid ||
    process.env.SUDO_USER === options.expectedUser
  ) {
    throw new Error("controller and graphical login accounts must be distinct");
  }
  const environment = contract.buildInteractiveEnvironment(
    request.environment,
    discovered,
  );
  let child = null;
  let childTerminal = null;
  let record = null;
  let runnerIdentityVerified = false;
  let terminalObserved = false;
  let launchError = null;
  let rejectStopRequest;
  const stopRequested = new Promise((_, reject) => {
    rejectStopRequest = reject;
  });
  const requestStop = () =>
    rejectStopRequest(new Error("root bridge stop requested before terminal"));
  process.once("SIGTERM", requestStop);
  process.once("SIGINT", requestStop);
  try {
    transientPaths.grantInteractiveJobTraversal(request.workingDirectory, {
      controllerUid: options.controllerUid,
      interactiveUid: discovered.interactiveUid,
      interactiveUser: discovered.interactiveUser,
      platform: process.platform,
    });
    transientPaths.prepareRunnerTransientPaths(
      request.workingDirectory,
      discovered.interactiveUid,
      options.controllerGid,
    );
    child = spawnUserChild(discovered, {
      ...request,
      environment,
      discovered,
    });
    childTerminal = childExit(child);
    const launch = await Promise.race([
      readFirstRecord(child.stdout),
      childTerminal.then(({ code, signal }) => {
        throw new Error(
          `user-session launcher exited before receipt: ${code ?? signal}`,
        );
      }),
      stopRequested,
    ]);
    record = launch.record;
    validateChildReceipt(record, discovered);
    const processProof = contract.verifyRunnerProcess(record.processId, {
      expectedUser: options.expectedUser,
      jobsRoot: options.jobsRoot,
    });
    runnerIdentityVerified = true;
    record.executionDomain = processProof.executionDomain;
    process.stdout.write(`${JSON.stringify(record)}\n${launch.remainder}`);
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    process.off("SIGTERM", requestStop);
    process.off("SIGINT", requestStop);
    const relayTerm = () => relayRunnerSignal(record.processId, "SIGTERM");
    const relayInt = () => relayRunnerSignal(record.processId, "SIGINT");
    process.once("SIGTERM", relayTerm);
    process.once("SIGINT", relayInt);
    const terminal = await childTerminal;
    terminalObserved = true;
    process.off("SIGTERM", relayTerm);
    process.off("SIGINT", relayInt);
    process.exitCode = terminal.code ?? 1;
  } catch (error) {
    launchError = error;
  } finally {
    process.off("SIGTERM", requestStop);
    process.off("SIGINT", requestStop);
    if (child?.exitCode === null && !terminalObserved) {
      try {
        if (!runnerIdentityVerified) {
          throw new Error(
            "runner identity was not verified before bridge launch failure",
          );
        }
        try {
          process.kill(-record.processId, "SIGKILL");
        } catch (error) {
          if (error?.code !== "ESRCH") throw error;
        }
        await waitForRunnerGroupAbsence(record.processId);
        if (child.exitCode === null) child.kill("SIGKILL");
        await waitForTerminal(childTerminal);
        process.stdout.write(
          `${JSON.stringify({
            schemaVersion: 1,
            recordType: "launch_cleanup",
            processId: record.processId,
            stopped: true,
            observedAt: new Date().toISOString(),
          })}\n`,
        );
      } catch (cleanupError) {
        launchError = new Error(
          "Unix bridge launch cleanup did not prove runner absence",
          { cause: cleanupError },
        );
      }
    }
  }
  if (launchError) throw launchError;
}

async function launchUserChild(options) {
  const request = validateRequest(await readStandardInput(), options.jobsRoot);
  if (
    process.getuid?.() < 1 ||
    request.discovered?.interactiveUid !== process.getuid?.() ||
    request.discovered.interactiveUser !== options.expectedUser ||
    options.expectedUser === "root" ||
    request.discovered.interactiveUser !== process.env.USER ||
    request.environment?.HOME !== process.env.HOME
  ) {
    throw new Error("user-session launcher identity does not match discovery");
  }
  process.umask(0o007);
  let child = null;
  let terminalObserved = false;
  let childTerminal = null;
  let rejectStopRequest;
  const stopRequested = new Promise((_, reject) => {
    rejectStopRequest = reject;
  });
  const requestStop = () =>
    rejectStopRequest(new Error("user-session launcher stop requested"));
  process.once("SIGTERM", requestStop);
  process.once("SIGINT", requestStop);
  try {
    child = spawn("./run.sh", request.arguments, {
      cwd: request.workingDirectory,
      env: request.environment,
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    childTerminal = childExit(child);
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        platform: request.discovered.platform,
        interactiveUser: request.discovered.interactiveUser,
        interactiveUid: request.discovered.interactiveUid,
        processId: child.pid,
        session: request.discovered.session,
      })}\n`,
    );
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    const terminal = await Promise.race([childTerminal, stopRequested]);
    terminalObserved = true;
    process.exitCode = terminal.code ?? 1;
  } finally {
    process.off("SIGTERM", requestStop);
    process.off("SIGINT", requestStop);
    if (child?.exitCode === null && !terminalObserved) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
      await waitForRunnerGroupAbsence(child.pid);
      await waitForTerminal(childTerminal);
    }
  }
}

async function stopRunnerGroup(options) {
  assertRootInvocation(options);
  const processId = Number(options.processId);
  if (!Number.isInteger(processId) || processId < 2) {
    throw new Error("runner stop process ID is invalid");
  }
  const timeoutMs = Number(options.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error("runner stop timeout is invalid");
  }
  if (runnerProcessGroupAbsent(processId)) return;
  const contract = await loadContract();
  contract.verifyRunnerProcess(processId, {
    expectedUser: options.expectedUser,
    jobsRoot: options.jobsRoot,
  });
  const signal = options.signal ?? "SIGTERM";
  if (!["SIGTERM", "SIGKILL"].includes(signal)) {
    throw new Error("runner stop signal is invalid");
  }
  try {
    process.kill(-processId, signal);
  } catch (error) {
    if (error?.code === "ESRCH") return;
    throw error;
  }
  await waitForRunnerGroupAbsence(processId, { timeoutMs, operation: signal });
}

function spawnUserChild(discovered, request) {
  const common = [
    process.execPath, bridgePath, "--user-child",
    "--jobs-root", dirname(request.workingDirectory),
    "--expected-user", discovered.interactiveUser,
  ];
  const command =
    process.platform === "linux" ? "/usr/sbin/runuser" : "/bin/launchctl";
  const args =
    process.platform === "linux"
      ? [
          "--user", discovered.interactiveUser,
          "--preserve-environment", "--",
          "/usr/bin/systemd-run", "--user", "--scope", "--quiet",
          "--wait", "--collect", "--same-dir", ...common,
        ]
      : [
          "asuser", String(discovered.interactiveUid),
          "/usr/bin/sudo", "-n", "-H", "-E",
          "-u", discovered.interactiveUser, "--", ...common,
        ];
  const child = spawn(command, args, {
    cwd: request.workingDirectory,
    env: request.environment,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(JSON.stringify(request));
  return child;
}

function validateRequest(requestText, jobsRoot) {
  const request = JSON.parse(requestText);
  if (
    request.schemaVersion !== 1 ||
    request.command !== "./run.sh" ||
    request.arguments?.length !== 2 ||
    request.arguments[0] !== "--jitconfig" ||
    !/^[A-Za-z0-9_+/=-]{20,}$/u.test(request.arguments[1] ?? "")
  ) {
    throw new Error("interactive-session launch request violates the runner contract");
  }
  const root = realpathSync(jobsRoot);
  const working = realpathSync(request.workingDirectory);
  if (
    !working.startsWith(`${root}${sep}`) ||
    basename(working) !== "runner" ||
    !existsSync(join(working, "run.sh"))
  ) {
    throw new Error("interactive-session working directory escapes jobs root");
  }
  return { ...request, workingDirectory: working };
}

function validateChildReceipt(record, discovered) {
  if (
    record?.schemaVersion !== 1 ||
    record.platform !== discovered.platform ||
    record.interactiveUser !== discovered.interactiveUser ||
    record.interactiveUid !== discovered.interactiveUid ||
    !Number.isInteger(record.processId) ||
    JSON.stringify(record.session) !== JSON.stringify(discovered.session)
  ) {
    throw new Error("user-session launcher receipt is invalid");
  }
}

export async function waitForRunnerGroupAbsence(
  processId,
  {
    probe = (id) => process.kill(-id, 0),
    now = () => Date.now(),
    wait = (milliseconds) =>
      new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
    timeoutMs = 5_000,
    pollMs = 50,
    operation = "SIGKILL",
  } = {},
) {
  if (
    !Number.isInteger(processId) ||
    processId < 2 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    !Number.isInteger(pollMs) ||
    pollMs < 1
  ) {
    throw new Error("runner process-group absence contract is invalid");
  }
  const deadline = now() + timeoutMs;
  for (;;) {
    try {
      probe(processId);
    } catch (error) {
      if (error?.code === "ESRCH") return;
      if (error?.code !== "EPERM") {
        throw new Error("runner process-group absence probe failed", {
          cause: error,
        });
      }
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new Error(`runner process group remained present after ${operation}`);
    }
    await wait(Math.min(pollMs, remaining));
  }
}

function runnerProcessGroupAbsent(
  processId,
  { probe = (id) => process.kill(-id, 0) } = {},
) {
  try {
    probe(processId);
    return false;
  } catch (error) {
    if (error?.code === "ESRCH") return true;
    if (error?.code === "EPERM") return false;
    throw new Error("runner process-group presence probe failed", {
      cause: error,
    });
  }
}

function assertRootInvocation(options) {
  if (
    process.getuid?.() !== 0 ||
    Number(process.env.SUDO_UID) !== options.controllerUid ||
    Number(process.env.SUDO_GID) !== options.controllerGid ||
    !isAbsolute(options.jobsRoot ?? "") ||
    !/^[a-z_][a-z0-9_-]*$/u.test(options.expectedUser ?? "")
  ) {
    throw new Error("Unix bridge requires the checked sudo controller identity");
  }
}

function parseOptions(argv) {
  const result = { stop: false, userChild: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--stop") result.stop = true;
    else if (argv[index] === "--user-child") result.userChild = true;
    else {
      const name = argv[index]
        .replace(/^--/u, "")
        .replace(/-([a-z])/gu, (_, character) => character.toUpperCase());
      result[name] = argv[++index];
    }
  }
  result.controllerUid = Number(result.controllerUid);
  result.controllerGid = Number(result.controllerGid);
  return result;
}

async function readStandardInput() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk.toString("utf8");
  return text;
}

function childExit(child) {
  return new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolvePromise({ code, signal }));
  });
}

function relayRunnerSignal(processId, signal) {
  try {
    process.kill(-processId, signal);
  } catch {
    // A concurrent runner exit is resolved by the child terminal result.
  }
}

async function waitForTerminal(terminal, timeoutMs = 5_000) {
  if (!terminal) return;
  let timer;
  try {
    const completed = await Promise.race([
      terminal.then(() => true),
      new Promise((resolvePromise) => {
        timer = setTimeout(() => resolvePromise(false), timeoutMs);
      }),
    ]);
    if (!completed) {
      throw new Error("runner bridge wrapper did not terminate after cleanup");
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function readFirstRecord(stream) {
  return new Promise((resolvePromise, reject) => {
    let buffered = "";
    stream.on("data", function onData(chunk) {
      buffered += chunk.toString("utf8");
      const newline = buffered.indexOf("\n");
      if (newline === -1) return;
      stream.off("data", onData);
      try {
        resolvePromise({
          record: JSON.parse(buffered.slice(0, newline)),
          remainder: buffered.slice(newline + 1),
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

if (process.argv[1] === bridgePath) {
  const options = parseOptions(process.argv.slice(2));
  if (options.userChild) await launchUserChild(options);
  else if (options.stop) await stopRunnerGroup(options);
  else await launchRootBridge(options);
}
