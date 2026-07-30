import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  chownSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildInteractiveEnvironment,
  discoverInteractiveSession,
} from "../services/unix-interactive-session-contract.mjs";
import {
  waitForRunnerGroupAbsence,
} from "../services/unix-interactive-session-bridge.mjs";
import {
  grantInteractiveJobTraversal,
  prepareRunnerTransientPaths,
  unixRunnerTransientPaths,
} from "../services/unix-runner-transient-paths.mjs";

const testDirectory = dirname(fileURLToPath(import.meta.url));

test("Linux discovery requires the checked unlocked local GNOME Wayland login", () => {
  const observations = linuxObservations();
  const session = discoverInteractiveSession("linux", "forge3d-lab", {
    execute: fakeExecute(observations),
    stat: (path) => ({
      uid: 1001,
      isSocket: () => path.endsWith("/bus"),
    }),
  });
  assert.equal(session.interactiveUser, "forge3d-lab");
  assert.equal(session.interactiveUid, 1001);
  assert.equal(session.interactiveGid, 1001);
  assert.equal(session.session.identifier, "3");
  assert.equal(session.session.type, "wayland");
  assert.equal(session.environment.WAYLAND_DISPLAY, "wayland-0");

  observations.set("loginctl:LockedHint", "yes");
  assert.throws(
    () =>
      discoverInteractiveSession("linux", "forge3d-lab", {
        execute: fakeExecute(observations),
        stat: (path) => ({
          uid: 1001,
          isSocket: () => path.endsWith("/bus"),
        }),
      }),
    /unavailable or unsafe/u,
  );
});

test("macOS discovery requires the checked unlocked on-console Aqua login", () => {
  const observations = new Map([
    ["/usr/bin/stat", "forge3d-lab"],
    ["/usr/bin/id", "501"],
    [
      "/usr/sbin/ioreg",
      '"CGSSessionOnConsoleKey" = Yes\n"CGSSessionScreenIsLocked" = No',
    ],
    ["/bin/launchctl", ""],
    [
      "/usr/bin/dscl",
      "NFSHomeDirectory: /Users/forge3d-lab",
    ],
  ]);
  const session = discoverInteractiveSession("darwin", "forge3d-lab", {
    execute: fakeExecute(observations),
  });
  assert.equal(session.interactiveUid, 501);
  assert.equal(session.interactiveGid, 501);
  assert.equal(session.session.identifier, "gui/501");
  assert.equal(session.session.displayServer, "WindowServer");

  observations.set("/usr/bin/stat", "some-other-user");
  assert.throws(
    () =>
      discoverInteractiveSession("darwin", "forge3d-lab", {
        execute: fakeExecute(observations),
      }),
    /unavailable or unsafe/u,
  );
});

test("interactive environment keeps runtime controls but replaces controller identity", () => {
  const discovered = {
    interactiveUser: "forge3d-lab",
    home: "/home/forge3d-lab",
    environment: {
      XDG_SESSION_ID: "3",
      XDG_SESSION_TYPE: "wayland",
      XDG_RUNTIME_DIR: "/run/user/1001",
      WAYLAND_DISPLAY: "wayland-0",
    },
  };
  const environment = buildInteractiveEnvironment(
    {
      PATH: "/opt/forge3d/bin:/usr/bin",
      HOME: "/var/lib/forge3d-lab-controller",
      XDG_SESSION_ID: "controller-session",
      FORGE3D_BROWSER_INVENTORY_HELPER: "/usr/local/libexec/inventory",
      FORGE3D_PLAYWRIGHT_MODULE: "/opt/forge3d/playwright/index.mjs",
    },
    discovered,
  );
  assert.equal(environment.HOME, "/home/forge3d-lab");
  assert.equal(environment.USER, "forge3d-lab");
  assert.equal(environment.XDG_SESSION_ID, "3");
  assert.equal(
    environment.FORGE3D_BROWSER_INVENTORY_HELPER,
    "/usr/local/libexec/inventory",
  );
  assert.throws(
    () =>
      buildInteractiveEnvironment(
        { FORGE3D_CONTROLLER_GITHUB_APP_ID: "must-not-cross" },
        discovered,
      ),
    /prohibited entry/u,
  );
});

test("runner handoff preserves the verified distribution ownership boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "forge3d-unix-runner-"));
  const runner = join(root, "runner");
  try {
    mkdirSync(runner);
    mkdirSync(join(runner, "bin"));
    writeFileSync(join(runner, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(runner, "bin", "Runner.Listener"), "immutable", {
      mode: 0o755,
    });
    const immutableBefore = statSync(join(runner, "bin", "Runner.Listener"));
    const runnerRoot = realpathSync(runner);
    const handoffCalls = [];
    const modeCalls = [];
    prepareRunnerTransientPaths(runner, 1001, 498, {
      chown: (path, uid, gid) => handoffCalls.push({ path, uid, gid }),
      chmod: (path, mode) => modeCalls.push({ path, mode }),
    });

    const policy = JSON.parse(
      readFileSync(
        join(
          testDirectory,
          "..",
          "..",
          "..",
          "crates",
          "forge3d-web",
          "tests",
          "infrastructure",
          "runner-transient-path-policy.json",
        ),
        "utf8",
      ),
    );
    assert.deepEqual(
      unixRunnerTransientPaths,
      policy.paths.map(({ pattern, kind }) => ({
        name: pattern.replace(/\/\*\*$/u, ""),
        kind,
      })),
    );
    assert.deepEqual(
      handoffCalls.map(({ path }) => path),
      unixRunnerTransientPaths.map(({ name }) => join(runnerRoot, name)),
    );
    assert.equal(
      handoffCalls.some(({ path }) => path.includes("Runner.Listener")),
      false,
    );
    assert.deepEqual(
      modeCalls,
      unixRunnerTransientPaths.map(({ name, kind }) => ({
        path: join(runnerRoot, name),
        mode: kind === "tree" ? 0o2770 : 0o660,
      })),
    );
    assert.equal(
      readFileSync(join(runner, "bin", "Runner.Listener"), "utf8"),
      "immutable",
    );
    const immutableAfter = statSync(join(runner, "bin", "Runner.Listener"));
    assert.equal(immutableAfter.uid, immutableBefore.uid);
    assert.equal(immutableAfter.gid, immutableBefore.gid);
    assert.equal(immutableAfter.mode, immutableBefore.mode);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("job-root traversal is granted only to the checked graphical identity", () => {
  const root = mkdtempSync(join(tmpdir(), "forge3d-unix-traversal-"));
  const job = join(root, "job");
  const runner = join(job, "runner");
  try {
    mkdirSync(job, { mode: 0o700 });
    mkdirSync(runner, { mode: 0o755 });
    const calls = [];
    const controllerUid = 498;
    const controllerOwnedStat = (path) => {
      const stats = statSync(path);
      return {
        isDirectory: () => stats.isDirectory(),
        isSymbolicLink: () => stats.isSymbolicLink(),
        uid: controllerUid,
      };
    };
    assert.equal(
      grantInteractiveJobTraversal(runner, {
        controllerUid,
        interactiveUid: controllerUid + 1,
        interactiveUser: "forge3d-lab",
        platform: "linux",
        execute: (command, args, options) =>
          calls.push({ command, args, options }),
        stat: controllerOwnedStat,
      }),
      realpathSync(job),
    );
    assert.deepEqual(calls, [
      {
        command: "/usr/bin/setfacl",
        args: [
          "--modify",
          `user:${controllerUid + 1}:--x`,
          "--",
          realpathSync(job),
        ],
        options: { stdio: ["ignore", "ignore", "inherit"] },
      },
    ]);

    calls.length = 0;
    grantInteractiveJobTraversal(runner, {
      controllerUid,
      interactiveUid: controllerUid + 1,
      interactiveUser: "forge3d-lab",
      platform: "darwin",
      execute: (command, args, options) =>
        calls.push({ command, args, options }),
      stat: controllerOwnedStat,
    });
    assert.deepEqual(calls, [
      {
        command: "/bin/chmod",
        args: [
          "+a",
          "user:forge3d-lab allow search",
          realpathSync(job),
        ],
        options: { stdio: ["ignore", "ignore", "inherit"] },
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "job-root ACL supports launch and cleanup across real Unix UIDs",
  { skip: process.env.FORGE3D_RUN_SEPARATE_UID_TEST !== "1" },
  () => {
    assert.equal(
      process.getuid?.(),
      0,
      "separate-UID test must run as root",
    );
    const sudoUid = Number(process.env.SUDO_UID);
    const sudoGid = Number(process.env.SUDO_GID);
    const controller =
      Number.isInteger(sudoUid) && sudoUid > 1 && Number.isInteger(sudoGid)
        ? { uid: sudoUid, gid: sudoGid }
        : unixIdentity("daemon");
    const identityCandidates = ["daemon", "www-data", "_www", "bin", "nobody"];
    const interactive = firstUnixIdentity(identityCandidates, [controller.uid]);
    const bystander = firstUnixIdentity(identityCandidates, [
      controller.uid,
      interactive.uid,
    ]);
    assert.notEqual(controller.uid, interactive.uid);
    assert.notEqual(interactive.uid, bystander.uid);

    const root = mkdtempSync(join(tmpdir(), "forge3d-unix-real-uid-"));
    const job = join(root, "job");
    const runner = join(job, "runner");
    const runScript = join(runner, "run.sh");
    try {
      chmodSync(root, 0o755);
      mkdirSync(job, { mode: 0o700 });
      mkdirSync(runner, { mode: 0o755 });
      writeFileSync(runScript, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      for (const path of [job, runner, runScript]) {
        chownSync(path, controller.uid, controller.gid);
      }
      grantInteractiveJobTraversal(runner, {
        controllerUid: controller.uid,
        interactiveUid: interactive.uid,
        interactiveUser: interactive.name,
      });
      prepareRunnerTransientPaths(
        runner,
        interactive.uid,
        controller.gid,
      );

      const launched = spawnSync(
        process.execPath,
        [
          "-e",
          [
            'const fs = require("node:fs");',
            'const path = require("node:path");',
            "process.umask(0o007);",
            "const runner = process.argv[1];",
            'const run = fs.realpathSync(path.join(runner, "run.sh"));',
            'fs.writeFileSync(path.join(runner, "_work", "output"), "ok");',
            "let immutableWriteBlocked = false;",
            "try { fs.appendFileSync(run, \"changed\"); }",
            "catch (error) { immutableWriteBlocked = [\"EACCES\", \"EPERM\"].includes(error.code); }",
            "process.stdout.write(JSON.stringify({ run, immutableWriteBlocked }));",
          ].join(""),
          runner,
        ],
        {
          uid: interactive.uid,
          gid: interactive.gid,
          encoding: "utf8",
        },
      );
      assert.equal(launched.status, 0, launched.stderr);
      assert.deepEqual(JSON.parse(launched.stdout), {
        run: runScript,
        immutableWriteBlocked: true,
      });
      const denied = spawnSync(
        process.execPath,
        [
          "-e",
          'require("node:fs").realpathSync(process.argv[1]);',
          runScript,
        ],
        {
          uid: bystander.uid,
          gid: bystander.gid,
          encoding: "utf8",
        },
      );
      assert.notEqual(denied.status, 0);
      const output = statSync(join(runner, "_work", "output"));
      assert.equal(output.gid, controller.gid);
      assert.equal(output.mode & 0o777, 0o660);
      assert.equal(statSync(job).mode & 0o707, 0o700);
      assert.equal(readFileSync(runScript, "utf8"), "#!/bin/sh\nexit 0\n");

      const cleaned = spawnSync(
        process.execPath,
        [
          "-e",
          'require("node:fs").rmSync(process.argv[1], { recursive: true });',
          join(runner, "_work"),
        ],
        {
          uid: controller.uid,
          gid: controller.gid,
          encoding: "utf8",
        },
      );
      assert.equal(cleaned.status, 0, cleaned.stderr);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("transient handoff has no privileged recursive reclamation surface", () => {
  const source = readFileSync(
    new URL("../services/unix-runner-transient-paths.mjs", import.meta.url),
    "utf8",
  );
  assert.equal(source.includes("readdirSync"), false);
  assert.equal(source.includes("reclaimRunnerTransientPaths"), false);
  assert.equal(source.includes("lchownSync"), false);
});

test("forced runner cleanup requires bounded process-group absence", async () => {
  let probes = 0;
  await waitForRunnerGroupAbsence(901, {
    probe: () => {
      probes += 1;
      if (probes === 3) {
        const error = new Error("absent");
        error.code = "ESRCH";
        throw error;
      }
    },
    now: () => 0,
    wait: async () => undefined,
  });
  assert.equal(probes, 3);

  let clock = 0;
  await assert.rejects(
    () =>
      waitForRunnerGroupAbsence(901, {
        probe: () => undefined,
        now: () => clock,
        wait: async (milliseconds) => {
          clock += milliseconds;
        },
        timeoutMs: 3,
        pollMs: 1,
      }),
    /remained present after SIGKILL/u,
  );
  assert.equal(clock, 3);
});

function unixIdentity(name) {
  return {
    name,
    uid: Number(execFileSync("/usr/bin/id", ["-u", name], {
      encoding: "utf8",
    }).trim()),
    gid: Number(execFileSync("/usr/bin/id", ["-g", name], {
      encoding: "utf8",
    }).trim()),
  };
}

function firstUnixIdentity(names, excludedUids) {
  for (const name of names) {
    try {
      const identity = unixIdentity(name);
      if (
        identity.uid > 0 &&
        identity.uid <= 0x7fffffff &&
        !excludedUids.includes(identity.uid)
      ) {
        return identity;
      }
    } catch {
      // Try the next standard non-root Unix identity.
    }
  }
  throw new Error("separate-UID test requires two standard non-root users");
}

function linuxObservations() {
  return new Map([
    ["/usr/bin/id", "1001"],
    ["loginctl:Display", "3"],
    ["loginctl:Name", "forge3d-lab"],
    ["loginctl:User", "1001"],
    ["loginctl:Active", "yes"],
    ["loginctl:LockedHint", "no"],
    ["loginctl:Remote", "no"],
    ["loginctl:Type", "wayland"],
    ["loginctl:Class", "user"],
    ["loginctl:State", "active"],
    [
      "/usr/sbin/runuser",
      "XDG_SESSION_TYPE=wayland\nWAYLAND_DISPLAY=wayland-0\nDISPLAY=:0",
    ],
    [
      "/usr/bin/getent",
      "forge3d-lab:x:1001:1001::/home/forge3d-lab:/bin/bash",
    ],
  ]);
}

function fakeExecute(observations) {
  return (command, args) => {
    const property = args.find((value) => value.startsWith("--property="));
    const key =
      command === "/usr/bin/loginctl"
        ? `loginctl:${property?.slice("--property=".length)}`
        : command;
    if (!observations.has(key)) {
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    }
    return observations.get(key);
  };
}
