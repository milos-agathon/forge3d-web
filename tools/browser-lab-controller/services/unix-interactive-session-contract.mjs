import { execFileSync } from "node:child_process";
import { readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, sep } from "node:path";

const runtimePrefixes = [
  "FORGE3D_BROWSER_",
  "FORGE3D_UPDATE_",
  "FORGE3D_PLAYWRIGHT_",
  "FORGE3D_GECKODRIVER_",
  "FORGE3D_APPIUM_",
  "FORGE3D_DEVICE_",
  "FORGE3D_CLOUDFLARED_",
  "FORGE3D_WDA_",
];
const derivedNames = new Set([
  "HOME",
  "USER",
  "LOGNAME",
  "USERPROFILE",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  "XDG_SESSION_ID",
  "XDG_SESSION_TYPE",
  "DBUS_SESSION_BUS_ADDRESS",
  "TMP",
  "TEMP",
  "TMPDIR",
]);

export function discoverInteractiveSession(
  platform,
  expectedUser,
  { execute = execFileSync, stat = statSync } = {},
) {
  validateUser(expectedUser);
  if (platform === "linux") {
    return discoverLinux(expectedUser, execute, stat);
  }
  if (platform === "darwin") {
    return discoverMac(expectedUser, execute);
  }
  throw new Error(`unsupported Unix bridge platform: ${platform}`);
}

function discoverLinux(expectedUser, execute, stat) {
  const uid = numericOutput(execute, "/usr/bin/id", ["-u", expectedUser]);
  const gid = numericOutput(execute, "/usr/bin/id", ["-g", expectedUser]);
  const sessionId = textOutput(execute, "/usr/bin/loginctl", [
    "show-user",
    expectedUser,
    "--property=Display",
    "--value",
  ]);
  const property = (name) =>
    textOutput(execute, "/usr/bin/loginctl", [
      "show-session",
      sessionId,
      `--property=${name}`,
      "--value",
    ]);
  const runtimeDirectory = `/run/user/${uid}`;
  const managerEnvironment = parseEnvironment(
    textOutput(
      execute,
      "/usr/sbin/runuser",
      [
        "--user",
        expectedUser,
        "--",
        "/usr/bin/env",
        `XDG_RUNTIME_DIR=${runtimeDirectory}`,
        `DBUS_SESSION_BUS_ADDRESS=unix:path=${runtimeDirectory}/bus`,
        "/usr/bin/systemctl",
        "--user",
        "show-environment",
      ],
    ),
  );
  if (
    uid < 1 ||
    sessionId === "" ||
    property("Name") !== expectedUser ||
    Number(property("User")) !== uid ||
    property("Active") !== "yes" ||
    property("LockedHint") !== "no" ||
    property("Remote") !== "no" ||
    property("Type") !== "wayland" ||
    property("Class") !== "user" ||
    property("State") !== "active" ||
    stat(runtimeDirectory).uid !== uid ||
    !stat(`${runtimeDirectory}/bus`).isSocket() ||
    !/^wayland-[0-9]+$/u.test(managerEnvironment.WAYLAND_DISPLAY ?? "")
  ) {
    throw new Error("Linux graphical login session is unavailable or unsafe");
  }
  const home = textOutput(execute, "/usr/bin/getent", [
    "passwd",
    expectedUser,
  ]).split(":")[5];
  if (!isAbsolute(home)) throw new Error("Linux login home is invalid");
  return {
    platform: "linux",
    interactiveUser: expectedUser,
    interactiveUid: uid,
    interactiveGid: gid,
    home,
    session: {
      identifier: sessionId,
      active: true,
      locked: false,
      remote: false,
      type: "wayland",
      displayServer: `GNOME Wayland ${managerEnvironment.WAYLAND_DISPLAY}`,
    },
    environment: {
      XDG_RUNTIME_DIR: runtimeDirectory,
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDirectory}/bus`,
      XDG_SESSION_ID: sessionId,
      XDG_SESSION_TYPE: "wayland",
      WAYLAND_DISPLAY: managerEnvironment.WAYLAND_DISPLAY,
      ...(managerEnvironment.DISPLAY
        ? { DISPLAY: managerEnvironment.DISPLAY }
        : {}),
    },
  };
}

function discoverMac(expectedUser, execute) {
  const consoleUser = textOutput(execute, "/usr/bin/stat", [
    "-f",
    "%Su",
    "/dev/console",
  ]);
  const uid = numericOutput(execute, "/usr/bin/id", ["-u", expectedUser]);
  const gid = numericOutput(execute, "/usr/bin/id", ["-g", expectedUser]);
  const sessionRecord = textOutput(execute, "/usr/sbin/ioreg", [
    "-n",
    "Root",
    "-d1",
  ]);
  execute("/bin/launchctl", ["print", `gui/${uid}`], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  const home = textOutput(execute, "/usr/bin/dscl", [
    ".",
    "-read",
    `/Users/${expectedUser}`,
    "NFSHomeDirectory",
  ]).replace(/^NFSHomeDirectory:\s*/u, "");
  if (
    uid < 1 ||
    consoleUser !== expectedUser ||
    !/"CGSSessionOnConsoleKey"\s*=\s*(?:Yes|true|1)/u.test(sessionRecord) ||
    /"CGSSessionScreenIsLocked"\s*=\s*(?:Yes|true|1)/u.test(sessionRecord) ||
    !isAbsolute(home)
  ) {
    throw new Error("macOS graphical login session is unavailable or unsafe");
  }
  return {
    platform: "darwin",
    interactiveUser: expectedUser,
    interactiveUid: uid,
    interactiveGid: gid,
    home,
    session: {
      identifier: `gui/${uid}`,
      active: true,
      locked: false,
      remote: false,
      type: "aqua",
      displayServer: "WindowServer",
    },
    environment: {},
  };
}

export function buildInteractiveEnvironment(requested, discovered) {
  const controls = {};
  for (const [name, value] of Object.entries(requested ?? {})) {
    if (
      name === "PATH" ||
      name === "LANG" ||
      name === "LC_ALL" ||
      runtimePrefixes.some((prefix) => name.startsWith(prefix))
    ) {
      if (typeof value !== "string" || value.includes("\0")) {
        throw new Error("interactive-session environment value is invalid");
      }
      controls[name] = value;
    } else if (!derivedNames.has(name)) {
      throw new Error("interactive-session environment contains a prohibited entry");
    }
  }
  return {
    PATH: controls.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: discovered.home,
    USER: discovered.interactiveUser,
    LOGNAME: discovered.interactiveUser,
    ...discovered.environment,
    ...controls,
  };
}

export function verifyRunnerProcess(
  processId,
  { expectedUser, jobsRoot, platform = process.platform, execute = execFileSync },
) {
  const owner = textOutput(execute, "/bin/ps", [
    "-p",
    String(processId),
    "-o",
    "user=",
  ]);
  const group = numericOutput(execute, "/bin/ps", [
    "-p",
    String(processId),
    "-o",
    "pgid=",
  ]);
  const working =
    platform === "linux"
      ? readlinkSync(`/proc/${processId}/cwd`)
      : textOutput(execute, "/usr/sbin/lsof", [
          "-a",
          "-p",
          String(processId),
          "-d",
          "cwd",
          "-Fn",
        ])
          .split("\n")
          .find((line) => line.startsWith("n"))
          ?.slice(1);
  const uid = numericOutput(execute, "/usr/bin/id", ["-u", expectedUser]);
  const cgroup =
    platform === "linux"
      ? readFileSync(`/proc/${processId}/cgroup`, "utf8")
      : "";
  const userManager =
    platform !== "linux" ||
    (cgroup.includes(`user-${uid}.slice`) &&
      (cgroup.includes(`user@${uid}.service`) ||
        cgroup.includes("session-")));
  if (
    owner !== expectedUser ||
    group !== processId ||
    !working ||
    !realpathSync(working).startsWith(`${realpathSync(jobsRoot)}${sep}`) ||
    !userManager
  ) {
    throw new Error("runner process is not the checked interactive process group");
  }
  return {
    workingDirectory: realpathSync(working),
    executionDomain:
      platform === "linux"
        ? "systemd-user-manager"
        : `launchd-gui/${uid}`,
  };
}

function parseEnvironment(text) {
  return Object.fromEntries(
    text
      .split(/\r?\n/u)
      .filter((line) => line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
}

function validateUser(value) {
  if (!/^[a-z_][a-z0-9_-]*$/u.test(value ?? "") || value === "root") {
    throw new Error("interactive login user is invalid");
  }
}

function textOutput(execute, command, args) {
  return execute(command, args, { encoding: "utf8" }).trim();
}

function numericOutput(execute, command, args) {
  const value = Number(textOutput(execute, command, args));
  if (!Number.isInteger(value)) {
    throw new Error("numeric session observation is invalid");
  }
  return value;
}
