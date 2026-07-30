import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  monitorAuthorizedJob,
  spawnRunner,
  stopRunner,
} from "../src/runner-execution.mjs";

const jitConfiguration = "opaqueJitConfiguration0123456789+/=";
const bridgeBytes = Buffer.from("checked interactive bridge");
const bridgeDigest = createHash("sha256").update(bridgeBytes).digest("hex");

test("Unix run.sh launches only through the digest-pinned graphical-session bridge", async () => {
  const calls = [];
  const stopCalls = [];
  let requestText = "";
  const child = fakeChild();
  child.stdin.on("data", (chunk) => {
    requestText += chunk.toString("utf8");
  });
  const spawnProcess = (command, args, options) => {
    calls.push({ command, args: [...args], options });
    queueMicrotask(() => {
      child.stdout.write(
        `${JSON.stringify({
          schemaVersion: 1,
          platform: "linux",
          interactiveUser: "forge3d-lab",
          interactiveUid: 1001,
          processId: 901,
          executionDomain: "systemd-user-manager",
          session: {
            identifier: "3",
            active: true,
            locked: false,
            remote: false,
            type: "wayland",
            displayServer: "GNOME Wayland wayland-0",
          },
        })}\n`,
      );
    });
    return child;
  };

  const result = await spawnRunner({
    command: "./run.sh",
    args: ["--jitconfig", jitConfiguration],
    cwd: "/var/lib/forge3d-browser-lab/jobs/nonce/runner",
    env: {
      PATH: "/usr/bin",
      FORGE3D_BROWSER_INVENTORY_HELPER: "/usr/local/libexec/inventory",
    },
    shell: false,
    echo: false,
    platform: "linux",
    interactiveSessionBridge: "/opt/forge3d/unix-session-bridge.mjs",
    interactiveSessionBridgeSha256: bridgeDigest,
    interactiveSessionUser: "forge3d-lab",
    jobsRoot: "/var/lib/forge3d-browser-lab/jobs",
    controllerUid: 498,
    controllerGid: 498,
    spawnProcess,
    readFile: () => bridgeBytes,
    execute: (command, args, options) => {
      stopCalls.push({ command, args, options });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "/usr/bin/sudo");
  assert.equal(calls[0].args.includes("./run.sh"), false);
  assert.equal(calls[0].args.includes(jitConfiguration), false);
  assert.equal(calls[0].options.shell, false);
  assert.equal(result.pid, 901);
  assert.equal(result.interactiveUser, "forge3d-lab");
  assert.equal(result.session.type, "wayland");
  assert.equal(result.executionDomain, "systemd-user-manager");
  result.killTree(result.pid, 11);
  result.forceKillTree(result.pid, 7);
  assert.equal(stopCalls.length, 2);
  assert.equal(stopCalls[0].command, "/usr/bin/sudo");
  assert.equal(stopCalls[0].args.includes("--signal"), false);
  assert.deepEqual(
    stopCalls[0].args.slice(-2),
    ["--timeout-ms", "11"],
  );
  assert.deepEqual(
    stopCalls[1].args.slice(-4),
    ["--signal", "SIGKILL", "--timeout-ms", "7"],
  );
  assert.equal(stopCalls[1].args.includes(jitConfiguration), false);
  assert.deepEqual(JSON.parse(requestText), {
    schemaVersion: 1,
    command: "./run.sh",
    arguments: ["--jitconfig", jitConfiguration],
    workingDirectory: "/var/lib/forge3d-browser-lab/jobs/nonce/runner",
    environment: {
      PATH: "/usr/bin",
      FORGE3D_BROWSER_INVENTORY_HELPER: "/usr/local/libexec/inventory",
    },
  });
  child.exitCode = 0;
  child.emit("exit", 0, null);
  child.stdout.end();
  child.stderr.end();
  await result.exit;
});

test("Unix runner rejects a missing, modified, or wrong-user session bridge", async () => {
  const base = {
    command: "./run.sh",
    args: ["--jitconfig", jitConfiguration],
    cwd: "/controller/jobs/nonce/runner",
    env: {},
    shell: false,
    echo: false,
    platform: "darwin",
    jobsRoot: "/controller/jobs",
    controllerUid: 498,
    controllerGid: 498,
  };
  await assert.rejects(
    () => spawnRunner(base),
    /pinned interactive-session bridge/u,
  );
  await assert.rejects(
    () =>
      spawnRunner({
        ...base,
        interactiveSessionBridge: "/controller/bridge.mjs",
        interactiveSessionBridgeSha256: "a".repeat(64),
        interactiveSessionUser: "forge3d-lab",
        readFile: () => bridgeBytes,
      }),
    /digest mismatch/u,
  );
  await assert.rejects(
    () =>
      spawnRunner({
        ...base,
        interactiveSessionBridge: "/controller/bridge.mjs",
        interactiveSessionBridgeSha256: bridgeDigest,
        interactiveSessionUser: "root",
        readFile: () => bridgeBytes,
      }),
    /pinned interactive-session bridge/u,
  );
});

test("Unix failed launch returns only checked process-group absence evidence", async () => {
  const child = fakeChild();
  const observedAt = "2026-07-29T10:05:00.000Z";
  const spawnProcess = () => {
    queueMicrotask(() => {
      child.stdout.write(
        `${JSON.stringify({
          schemaVersion: 1,
          recordType: "launch_cleanup",
          processId: 901,
          stopped: true,
          observedAt,
        })}\n`,
      );
    });
    return child;
  };

  await assert.rejects(
    () =>
      spawnRunner({
        command: "./run.sh",
        args: ["--jitconfig", jitConfiguration],
        cwd: "/var/lib/forge3d-browser-lab/jobs/nonce/runner",
        env: {},
        shell: false,
        echo: false,
        platform: "linux",
        interactiveSessionBridge: "/opt/forge3d/unix-session-bridge.mjs",
        interactiveSessionBridgeSha256: bridgeDigest,
        interactiveSessionUser: "forge3d-lab",
        jobsRoot: "/var/lib/forge3d-browser-lab/jobs",
        controllerUid: 498,
        controllerGid: 498,
        spawnProcess,
        readFile: () => bridgeBytes,
      }),
    (error) => {
      assert.equal(error.runnerAbsenceProven, true);
      assert.deepEqual(error.listenerStopEvidence, {
        attempted: true,
        stopped: true,
        processId: 901,
        observedAt,
      });
      return true;
    },
  );
});

test("Windows run.cmd launches only through the digest-pinned console bridge", async () => {
  const calls = [];
  let requestText = "";
  const child = fakeChild();
  child.stdin.on("data", (chunk) => {
    requestText += chunk.toString("utf8");
  });
  const spawnProcess = (command, args, options) => {
    calls.push({ command, args: [...args], options });
    queueMicrotask(() => {
      child.stdout.write(
        `${JSON.stringify({
          schemaVersion: 1,
          processId: 812,
          consoleSessionId: 3,
          desktop: "winsta0\\default",
        })}\n`,
      );
    });
    return child;
  };

  const result = await spawnRunner({
    command: "run.cmd",
    args: ["--jitconfig", jitConfiguration],
    cwd: "C:\\Forge3D\\jobs\\nonce\\runner",
    env: { PATH: "C:\\Windows\\System32" },
    shell: false,
    echo: false,
    platform: "win32",
    interactiveSessionBridge:
      "C:\\ProgramData\\Forge3D\\windows-interactive-session-bridge.ps1",
    interactiveSessionBridgeSha256: bridgeDigest,
    jobsRoot: "C:\\Forge3D\\jobs",
    spawnProcess,
    readFile: () => bridgeBytes,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "powershell.exe");
  assert.equal(calls[0].args.includes("run.cmd"), false);
  assert.equal(calls[0].args.includes(jitConfiguration), false);
  assert.equal(calls[0].options.shell, false);
  assert.equal(result.pid, 812);
  assert.equal(result.consoleSessionId, 3);
  assert.deepEqual(JSON.parse(requestText), {
    schemaVersion: 1,
    command: "run.cmd",
    arguments: ["--jitconfig", jitConfiguration],
    workingDirectory: "C:\\Forge3D\\jobs\\nonce\\runner",
    environment: { PATH: "C:\\Windows\\System32" },
  });
  child.exitCode = 0;
  child.emit("exit", 0, null);
  child.stdout.end();
  child.stderr.end();
  await result.exit;
});

test("Windows runner rejects a missing or modified session bridge", async () => {
  await assert.rejects(
    () =>
      spawnRunner({
        command: "run.cmd",
        args: ["--jitconfig", jitConfiguration],
        cwd: "C:\\Forge3D\\jobs\\nonce\\runner",
        env: {},
        shell: false,
        echo: false,
        platform: "win32",
      }),
    /pinned interactive-session bridge/u,
  );
  await assert.rejects(
    () =>
      spawnRunner({
        command: "run.cmd",
        args: ["--jitconfig", jitConfiguration],
        cwd: "C:\\Forge3D\\jobs\\nonce\\runner",
        env: {},
        shell: false,
        echo: false,
        platform: "win32",
        interactiveSessionBridge: "C:\\Forge3D\\bridge.ps1",
        interactiveSessionBridgeSha256: "a".repeat(64),
        jobsRoot: "C:\\Forge3D\\jobs",
        spawnProcess: () => {
          throw new Error("must not spawn");
        },
        readFile: () => bridgeBytes,
      }),
    /digest mismatch/u,
  );
});

test("Windows failed launch returns job-object tree termination evidence", async () => {
  const child = fakeChild();
  const observedAt = "2026-07-29T10:05:00.000Z";
  const spawnProcess = () => {
    queueMicrotask(() => {
      child.stdout.write(
        `${JSON.stringify({
          schemaVersion: 1,
          recordType: "launch_cleanup",
          processStarted: true,
          processId: 812,
          stopped: true,
          observedAt,
        })}\n`,
      );
    });
    return child;
  };

  await assert.rejects(
    () =>
      spawnRunner({
        command: "run.cmd",
        args: ["--jitconfig", jitConfiguration],
        cwd: "C:\\Forge3D\\jobs\\nonce\\runner",
        env: {},
        shell: false,
        echo: false,
        platform: "win32",
        interactiveSessionBridge:
          "C:\\ProgramData\\Forge3D\\windows-interactive-session-bridge.ps1",
        interactiveSessionBridgeSha256: bridgeDigest,
        jobsRoot: "C:\\Forge3D\\jobs",
        spawnProcess,
        readFile: () => bridgeBytes,
      }),
    (error) => {
      assert.equal(error.runnerAbsenceProven, true);
      assert.deepEqual(error.listenerStopEvidence, {
        attempted: true,
        stopped: true,
        processId: 812,
        observedAt,
      });
      return true;
    },
  );
});

test("Windows stop terminates the interactive runner tree before its bridge", async () => {
  let resolveExit;
  const child = { exitCode: null, kill: () => undefined };
  const calls = [];
  const runnerProcess = {
    pid: 812,
    child,
    platform: "win32",
    stopped: false,
    exit: new Promise((resolvePromise) => {
      resolveExit = resolvePromise;
    }),
    killTree: (pid) => {
      calls.push(pid);
      child.exitCode = 1;
      resolveExit({ code: 1, signal: null });
    },
  };
  await stopRunner(runnerProcess);
  assert.deepEqual(calls, [812]);
  assert.equal(runnerProcess.stopped, true);
});

test("assignment timeout waits for broker-observed online-idle deadline evidence", async () => {
  const deadline = "2026-07-29T10:01:30.000Z";
  const beforeDeadline = "2026-07-29T10:01:29.000Z";
  const atDeadline = "2026-07-29T10:01:30.000Z";
  const lifecycle = [
    brokerLifecycle({
      state: "issued",
      onlineAt: null,
      assignmentDeadline: null,
      runnerObservation: null,
      jobObservation: null,
    }),
    brokerLifecycle({
      assignmentDeadline: deadline,
      runnerObservedAt: atDeadline,
      jobObservedAt: atDeadline,
    }),
    brokerLifecycle({
      assignmentDeadline: deadline,
      runnerObservedAt: atDeadline,
      jobObservedAt: atDeadline,
    }),
  ];
  let lifecycleIndex = 0;
  const runnerProcess = stoppedRunnerProcess(901);
  const result = await monitorAuthorizedJob({
    github: {
      getJob: async () => ({ id: 11, status: "queued" }),
    },
    runnerProcess,
    authorization: {
      queuedHardwareJob: { id: 11 },
    },
    brokerLifecycle: async () =>
      lifecycle[Math.min(lifecycleIndex++, lifecycle.length - 1)],
    now: () => new Date("2026-07-29T10:05:00.000Z"),
    runnerExitPollMs: 1,
  });

  assert.equal(result.reason, "online_unassigned");
  assert.equal(result.runnerBusy, false);
  assert.equal(runnerProcess.stopped, true);
  assert.ok(lifecycleIndex >= 3);
  assert.ok(Date.parse(beforeDeadline) < Date.parse(deadline));
});

test("assignment timeout rejects stale or ever-busy broker observations", async () => {
  const deadline = "2026-07-29T10:01:30.000Z";
  let jobPoll = 0;
  const observations = [
    brokerLifecycle({
      assignmentDeadline: deadline,
      runnerObservedAt: "2026-07-29T10:01:29.000Z",
      jobObservedAt: "2026-07-29T10:01:29.000Z",
    }),
    brokerLifecycle({
      assignmentDeadline: deadline,
      everBusy: true,
      runnerObservedAt: "2026-07-29T10:01:31.000Z",
      jobObservedAt: "2026-07-29T10:01:31.000Z",
    }),
  ];
  let lifecycleIndex = 0;
  const runnerProcess = stoppedRunnerProcess(901);
  const result = await monitorAuthorizedJob({
    github: {
      getJob: async () => {
        jobPoll += 1;
        if (jobPoll >= 3) {
          runnerProcess.exit = Promise.resolve({ code: 0, signal: null });
        }
        return {
          id: 11,
          status: jobPoll >= 3 ? "completed" : "queued",
        };
      },
    },
    runnerProcess,
    authorization: {
      queuedHardwareJob: { id: 11 },
    },
    brokerLifecycle: async () =>
      observations[Math.min(lifecycleIndex++, observations.length - 1)],
    now: () => new Date("2026-07-29T10:05:00.000Z"),
    runnerExitPollMs: 1,
  });

  assert.equal(result.reason, "terminal");
  assert.equal(runnerProcess.stopped, false);
});

test("Unix stop terminates the interactive runner group through its bridge", async () => {
  let resolveExit;
  const child = { exitCode: null, kill: () => undefined };
  const calls = [];
  const runnerProcess = {
    pid: 901,
    child,
    platform: "linux",
    requiresCheckedProcessGroupAbsence: true,
    stopped: false,
    exit: new Promise((resolvePromise) => {
      resolveExit = resolvePromise;
    }),
    killTree: (pid) => {
      calls.push(pid);
      child.exitCode = 1;
      resolveExit({ code: 1, signal: null });
    },
  };
  await stopRunner(runnerProcess);
  assert.deepEqual(calls, [901]);
  assert.equal(runnerProcess.stopped, true);
});

test("Unix stop checks the runner group after the launch bridge exits", async () => {
  const calls = [];
  const runnerProcess = {
    pid: 901,
    child: { exitCode: 137, kill: () => undefined },
    platform: "linux",
    requiresCheckedProcessGroupAbsence: true,
    stopped: false,
    exit: Promise.resolve({ code: null, signal: "SIGKILL" }),
    killTree: (pid, timeoutMs) => {
      calls.push(["SIGTERM", pid, timeoutMs]);
      throw new Error("runner process group remained present");
    },
    forceKillTree: (pid, timeoutMs) => {
      calls.push(["SIGKILL", pid, timeoutMs]);
    },
  };

  await stopRunner(runnerProcess, {
    gracefulTimeoutMs: 11,
    forceTimeoutMs: 7,
  });

  assert.deepEqual(calls, [
    ["SIGTERM", 901, 11],
    ["SIGKILL", 901, 7],
  ]);
  assert.equal(runnerProcess.stopped, true);
});

test("Unix stop escalates to checked process-group SIGKILL after timeout", async () => {
  let resolveExit;
  const child = { exitCode: null, kill: () => undefined };
  const calls = [];
  const runnerProcess = {
    pid: 901,
    child,
    platform: "linux",
    requiresCheckedProcessGroupAbsence: true,
    stopped: false,
    exit: new Promise((resolvePromise) => {
      resolveExit = resolvePromise;
    }),
    killTree: (pid) => {
      calls.push(["SIGTERM", pid]);
      throw new Error("runner process group remained present");
    },
    forceKillTree: (pid) => {
      calls.push(["SIGKILL", pid]);
      child.exitCode = 1;
      resolveExit({ code: null, signal: "SIGKILL" });
    },
  };
  await stopRunner(runnerProcess, {
    gracefulTimeoutMs: 1,
    forceTimeoutMs: 20,
  });
  assert.deepEqual(calls, [
    ["SIGTERM", 901],
    ["SIGKILL", 901],
  ]);
  assert.equal(runnerProcess.stopped, true);
  assert.equal(runnerProcess.cleanupFailed, undefined);
});

test("Unix stop bounds force-kill absence and leaves cleanup unproven", async () => {
  const calls = [];
  const runnerProcess = {
    pid: 901,
    child: { exitCode: null, kill: () => undefined },
    platform: "linux",
    requiresCheckedProcessGroupAbsence: true,
    stopped: false,
    exit: new Promise(() => undefined),
    killTree: (pid) => {
      calls.push(["SIGTERM", pid]);
      throw new Error("runner process group remained present");
    },
    forceKillTree: (pid) => {
      calls.push(["SIGKILL", pid]);
      throw new Error("runner process group remained present");
    },
  };
  await assert.rejects(
    () =>
      stopRunner(runnerProcess, {
        gracefulTimeoutMs: 1,
        forceTimeoutMs: 1,
      }),
    /checked runner process-group cleanup failed/u,
  );
  assert.deepEqual(calls, [
    ["SIGTERM", 901],
    ["SIGKILL", 901],
  ]);
  assert.equal(runnerProcess.stopped, false);
  assert.equal(runnerProcess.cleanupFailed, true);
});

test("Unix stop rejects an unproven force kill even if the bridge exits", async () => {
  let resolveExit;
  const runnerProcess = {
    pid: 901,
    child: { exitCode: null, kill: () => undefined },
    platform: "linux",
    requiresCheckedProcessGroupAbsence: true,
    stopped: false,
    exit: new Promise((resolvePromise) => {
      resolveExit = resolvePromise;
    }),
    killTree: () => {
      throw new Error("runner process group remained present");
    },
    forceKillTree: () => {
      resolveExit({ code: 1, signal: null });
      throw new Error("absence check failed");
    },
  };
  await assert.rejects(
    () =>
      stopRunner(runnerProcess, {
        gracefulTimeoutMs: 1,
        forceTimeoutMs: 20,
      }),
    /checked runner process-group cleanup failed/u,
  );
  assert.equal(runnerProcess.stopped, false);
  assert.equal(runnerProcess.cleanupFailed, true);
});

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 411;
  child.exitCode = null;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.spawnargs = ["powershell.exe", "<arguments>"];
  child.kill = () => {
    child.exitCode = 1;
    child.emit("exit", 1, null);
  };
  return child;
}

function stoppedRunnerProcess(pid) {
  return {
    pid,
    child: { exitCode: 0, kill: () => undefined },
    exit: new Promise(() => undefined),
    stopped: false,
  };
}

function brokerLifecycle({
  state = "online_unassigned",
  onlineAt = "2026-07-29T10:00:00.000Z",
  assignmentDeadline = "2026-07-29T10:01:30.000Z",
  everBusy = false,
  runnerObservation,
  runnerObservedAt = "2026-07-29T10:01:30.000Z",
  jobObservation,
  jobObservedAt = "2026-07-29T10:01:30.000Z",
}) {
  return {
    state,
    onlineAt,
    assignmentDeadline,
    everBusy,
    lastRunnerObservation:
      runnerObservation === null
        ? null
        : {
            id: 7,
            name: `FW-LNX-NV-01-${"ab".repeat(16)}`,
            status: "online",
            busy: false,
            observedAt: runnerObservedAt,
          },
    lastJobObservation:
      jobObservation === null
        ? null
        : {
            id: 11,
            status: "queued",
            conclusion: null,
            observedAt: jobObservedAt,
          },
  };
}
