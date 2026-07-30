import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("every installed service launches polling orchestration, not health-only mode", () => {
  for (const name of [
    "browser-lab-controller.service",
    "com.forge3d.browser-lab-controller.plist",
    "forge3d-browser-lab-controller.xml",
  ]) {
    const text = readFileSync(join(root, "services", name), "utf8");
    assert.match(text, /controller-service\.mjs/u);
    assert.equal(text.includes("controller-health-service.mjs"), false);
  }
  const service = readFileSync(
    join(root, "src", "controller-service.mjs"),
    "utf8",
  );
  assert.match(service, /startControllerPolling/u);
  assert.match(service, /new BrowserLabController/u);
  assert.match(service, /new ControllerBrokerClient/u);
  assert.match(service, /createControllerHealthServer/u);
});

test("Windows service delegates runner launch to the pinned physical-console bridge", () => {
  const service = readFileSync(
    join(root, "services", "forge3d-browser-lab-controller.xml"),
    "utf8",
  );
  const bridge = readFileSync(
    join(root, "services", "windows-interactive-session-bridge.ps1"),
    "utf8",
  );
  const digest = createHash("sha256").update(bridge).digest("hex");
  assert.match(service, /FORGE3D_CONTROLLER_WINDOWS_SESSION_BRIDGE/u);
  assert.match(service, /<username>LocalSystem<\/username>/u);
  assert.match(
    service,
    new RegExp(
      `FORGE3D_CONTROLLER_WINDOWS_SESSION_BRIDGE_SHA256" value="${digest}"`,
      "u",
    ),
  );
  for (const contract of [
    "WTSGetActiveConsoleSessionId",
    "WTSQueryUserToken",
    "CreateProcessAsUser",
    "CreateJobObject",
    "AssignProcessToJobObject",
    "TerminateJobObject",
    "QueryInformationJobObject",
    "WaitForSingleObject",
    "winsta0\\\\default",
    "active physical console session is locked",
    "run.cmd",
    "\\$forwarded",
    "\\$derived",
  ]) {
    assert.match(bridge, new RegExp(contract, "u"));
  }
  assert.equal(bridge.includes("Start-Process"), false);
});

test("macOS and Linux services delegate to the pinned graphical-login bridge", () => {
  const linux = readFileSync(
    join(root, "services", "browser-lab-controller.service"),
    "utf8",
  );
  const mac = readFileSync(
    join(root, "services", "com.forge3d.browser-lab-controller.plist"),
    "utf8",
  );
  const bridge = readFileSync(
    join(root, "services", "unix-interactive-session-bridge.mjs"),
    "utf8",
  );
  const contract = readFileSync(
    join(root, "services", "unix-interactive-session-contract.mjs"),
    "utf8",
  );
  const transientPaths = readFileSync(
    join(root, "services", "unix-runner-transient-paths.mjs"),
    "utf8",
  );
  const linuxSudoers = readFileSync(
    join(root, "services", "browser-lab-controller.sudoers-linux"),
    "utf8",
  );
  const macSudoers = readFileSync(
    join(root, "services", "browser-lab-controller.sudoers-macos"),
    "utf8",
  );
  const bridgeDigest = createHash("sha256").update(bridge).digest("hex");
  const contractDigest = createHash("sha256").update(contract).digest("hex");
  const transientPathsDigest = createHash("sha256")
    .update(transientPaths)
    .digest("hex");
  for (const service of [linux, mac]) {
    assert.match(service, /FORGE3D_CONTROLLER_UNIX_SESSION_BRIDGE/u);
    assert.match(service, new RegExp(bridgeDigest, "u"));
    assert.match(service, /FORGE3D_CONTROLLER_INTERACTIVE_USER/u);
    assert.match(service, /forge3d-lab/u);
  }
  assert.match(linux, /User=forge3d-lab-controller/u);
  assert.match(linux, /NoNewPrivileges=false/u);
  assert.match(mac, /<key>UserName<\/key>\s*<string>forge3d-lab-controller/u);
  assert.match(bridge, new RegExp(contractDigest, "u"));
  assert.match(bridge, new RegExp(transientPathsDigest, "u"));
  for (const contractText of [
    "loginctl",
    "LockedHint",
    "Remote",
    "wayland",
    "CGSSessionOnConsoleKey",
    "CGSSessionScreenIsLocked",
    "WindowServer",
  ]) {
    assert.match(contract, new RegExp(contractText, "u"));
  }
  assert.match(bridge, /launchctl/u);
  assert.match(bridge, /runuser/u);
  assert.match(bridge, /systemd-run/u);
  assert.match(bridge, /--user", "--scope/u);
  assert.match(bridge, /--preserve-environment/u);
  assert.match(bridge, /process\.kill\(-processId/u);
  assert.match(bridge, /await waitForRunnerGroupAbsence\(record\.processId\)/u);
  assert.match(bridge, /if \(runnerProcessGroupAbsent\(processId\)\) return/u);
  assert.match(
    bridge,
    /await waitForRunnerGroupAbsence\(processId, \{ timeoutMs, operation: signal \}\)/u,
  );
  assert.match(bridge, /process\.getuid\?\.\(\) < 1/u);
  assert.equal(transientPaths.includes('"chown", ["-R"'), false);
  for (const sudoers of [linuxSudoers, macSudoers]) {
    assert.match(sudoers, /^forge3d-lab-controller ALL=\(root\) NOPASSWD:/u);
    assert.match(sudoers, /--expected-user forge3d-lab/u);
    assert.match(sudoers, /--controller-uid \* --controller-gid \*/u);
    assert.match(sudoers, /unix-interactive-session-bridge\.mjs --stop/u);
    assert.match(sudoers, /--process-id \*/u);
    assert.match(sudoers, /--process-id \* --timeout-ms \*/u);
    assert.match(
      sudoers.trim(),
      /--process-id \* --signal SIGKILL --timeout-ms \*$/u,
    );
    assert.equal(sudoers.includes("--user-child"), false);
    assert.equal(sudoers.trim().split("\n").length, 1);
  }
  assert.equal(
    statSync(
      join(root, "services", "unix-interactive-session-bridge.mjs"),
    ).mode & 0o777,
    0o755,
  );
  for (const name of [
    "unix-interactive-session-contract.mjs",
    "unix-runner-transient-paths.mjs",
  ]) {
    assert.equal(statSync(join(root, "services", name)).mode & 0o777, 0o644);
  }
  for (const name of [
    "browser-lab-controller.sudoers-linux",
    "browser-lab-controller.sudoers-macos",
  ]) {
    assert.equal(statSync(join(root, "services", name)).mode & 0o777, 0o440);
  }
});
