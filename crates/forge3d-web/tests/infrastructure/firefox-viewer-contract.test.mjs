import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  FFX03_SELENIUM_VERSION,
  cleanupFirefox,
  keyboardActions,
  matchingProcesses,
  observeWebGpuPreferences,
  pointerCaptureAction,
  waitForNoNewProcess,
  waitForPidAbsent,
} from "../webdriver/firefox-viewer.mjs";

test("Firefox acceptance module exposes the exact Selenium client contract", () => {
  assert.equal(FFX03_SELENIUM_VERSION, "4.35.0");
});

test("Firefox profile observation retains only targeted WebGPU preferences", () => {
  withProfile((profile) => {
    writeFileSync(join(profile, "user.js"), [
      'user_pref("remote.active-protocols", 1);',
      'user_pref("dom.webgpu.enabled", true);',
      "",
    ].join("\n"));
    assert.deepEqual(observeWebGpuPreferences(profile), { "dom.webgpu.enabled": true });
  });
});

test("Firefox profile observation rejects malformed, conflicting, and linked relevant sources", () => {
  withProfile((profile) => {
    writeFileSync(join(profile, "user.js"), 'user_pref("dom.webgpu.enabled", maybe);\n');
    assert.throws(() => observeWebGpuPreferences(profile), /malformed relevant preference/u);
  });
  withProfile((profile) => {
    writeFileSync(join(profile, "user.js"), 'user_pref("dom.webgpu.enabled", true);\n');
    writeFileSync(join(profile, "prefs.js"), 'user_pref("dom.webgpu.enabled", false);\n');
    assert.throws(() => observeWebGpuPreferences(profile), /conflicting WebGPU preferences/u);
  });
  withProfile((profile) => {
    const outside = join(tmpdir(), `ffx03-user-${process.pid}-${Date.now()}.js`);
    writeFileSync(outside, 'user_pref("dom.webgpu.enabled", true);\n');
    try {
      symlinkSync(outside, join(profile, "user.js"));
      assert.throws(() => observeWebGpuPreferences(profile), /unsafe/u);
    } finally { rmSync(outside, { force: true }); }
  });
});

test("Firefox keyboard path sends a supported literal minus and observes every action", async () => {
  let frame = 0;
  const sent = [];
  const canvas = { click: async () => undefined, sendKeys: async (value) => { sent.push(value); frame += 1; } };
  const driver = {
    executeScript: async () => ({ view: { frame }, submittedFrames: frame }),
    wait: async (predicate) => assert.equal(await predicate(), true),
  };
  const result = await keyboardActions(driver, canvas);
  assert.equal(sent.length, 5);
  assert.equal(sent[3], "-");
  assert.equal(Object.values(result).every((entry) => entry.changed), true);
});

test("outside pointer capture compares its own immediate snapshot and rejects a no-op drag", async () => {
  let events = { got: [99], lost: [99] };
  const view = { yaw: 7, pitch: 3 };
  const driver = {
    executeScript: async (source) => {
      if (source.includes("= { got: [], lost: [] }")) { events = { got: [], lost: [] }; return undefined; }
      if (source.includes("got:")) return { view, diagnostics: { activePointers: 1 }, got: [...events.got, 5] };
      if (source.includes("lost:")) return { diagnostics: { activePointers: 0 }, lost: [...events.lost, 5] };
      return { view, submittedFrames: 4 };
    },
    actions: () => actionChain(),
  };
  const result = await pointerCaptureAction(driver, { getRect: async () => ({ x: 1, y: 2, width: 10, height: 10 }) });
  assert.equal(result.pointerId, 5);
  assert.equal(result.released, true);
  assert.equal(result.outsideMoveChanged, false);
});

test("Firefox process inspection fails closed for command and malformed output", () => {
  assert.throws(() => matchingProcesses("/driver", 4446, "linux", () => {
    throw new Error("inspection denied");
  }), /inspection denied/u);
  assert.throws(() => matchingProcesses("/driver", 4446, "linux", () => "not-a-pid /driver 4446\n"),
    /malformed process rows/u);
  assert.throws(() => matchingProcesses("C:\\driver.exe", 4446, "win32", () => "{"),
    /malformed Windows JSON/u);
  assert.throws(() => matchingProcesses("C:\\driver.exe", 4446, "win32", () =>
    JSON.stringify({ ProcessId: "nope", CommandLine: "C:\\driver.exe 4446" })), /malformed Windows rows/u);
  for (const ProcessId of [-1, "12"]) assert.throws(() =>
    matchingProcesses("C:\\driver.exe", 4446, "win32", () => JSON.stringify({
      ProcessId, CommandLine: "C:\\driver.exe 4446",
    })), /malformed Windows rows/u);
});

test("Windows process inspection accepts enumerated PID 0 but never treats it as actionable", () => {
  const execute = () => JSON.stringify([
    { ProcessId: 0, CommandLine: "C:\\driver.exe 4446" },
    { ProcessId: 72, CommandLine: "C:\\driver.exe 4446" },
  ]);
  assert.deepEqual([...matchingProcesses("C:\\driver.exe", 4446, "win32", execute)], [72]);
  assert.deepEqual([...matchingProcesses("C:\\driver.exe", 4446, "win32", () => JSON.stringify({
    ProcessId: 0, CommandLine: "C:\\driver.exe 4446",
  }))], []);
});

test("Firefox process absence rejects permission errors and still-running PIDs", async () => {
  const denied = Object.assign(new Error("denied"), { code: "EPERM" });
  await assert.rejects(waitForPidAbsent(10, { inspect: () => { throw denied; }, attempts: 1,
    delay: async () => undefined }), /denied/u);
  assert.equal(await waitForPidAbsent(10, { inspect: () => undefined, attempts: 1,
    delay: async () => undefined }), false);
  assert.equal(await waitForNoNewProcess("/driver", 4446, new Set(), "linux", {
    inspect: () => new Set([22]), attempts: 1, delay: async () => undefined,
  }), false);
});

test("Firefox cleanup marks the process stopped only after absence is proven", async () => {
  const marked = [];
  const base = { driver: null, service: { kill: async () => undefined }, driverPid: 22,
    firefoxPid: 33, baseline: new Set(), geckodriverPath: "/driver", port: 4446,
    platform: "linux", processRegistryPath: "/registry", markProcessStopped: (...args) => marked.push(args) };
  await assert.rejects(cleanupFirefox({ ...base, waitForNoNewProcessFn: async () => false,
    waitForPidAbsentFn: async () => true }), /CLEANUP_UNPROVEN/u);
  assert.deepEqual(marked, []);
  const result = await cleanupFirefox({ ...base, waitForNoNewProcessFn: async () => true,
    waitForPidAbsentFn: async () => true });
  assert.equal(result.ok, true);
  assert.deepEqual(marked, [["/registry", 22]]);
});

function actionChain() {
  const chain = {};
  for (const name of ["move", "press", "release"]) chain[name] = () => chain;
  chain.perform = async () => undefined;
  return chain;
}

function withProfile(run) {
  const profile = mkdtempSync(join(tmpdir(), "ffx03-profile-"));
  try { run(profile); } finally { rmSync(profile, { recursive: true, force: true }); }
}
