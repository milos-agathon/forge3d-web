import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertSafeLaunchArguments,
  captureHostInventory,
  observeLiveSession,
} from "../../scripts/capture-host-inventory.mjs";
import {
  assertUpdateWindowActive,
  closeUpdateWindow,
  createPendingUpdateWindow,
  createUpdateWindow,
  enforceHostUpdatePolicy,
} from "../../scripts/manage-browser-update-window.mjs";
import { resolveHostRuntime } from "../../scripts/resolve-host-runtime.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const inventoryHelper = join(root, "../../scripts/capture-host-inventory.mjs");
const inventoryHelperSha256 = createHash("sha256")
  .update(readFileSync(inventoryHelper))
  .digest("hex");
const policy = JSON.parse(readFileSync(join(root, "browser-policy.json"), "utf8"));
const tools = {
  ...policy.tools,
  safaridriverVersion: "Included with Safari 26.0",
};
const browser = {
  id: "chrome-stable",
  channel: "stable",
  classification: "required",
  automation: "playwright",
  version: "150.0.7339.1",
  executable: "/Applications/Google Chrome.app",
};

test("INF-01 policy freezes the required shipping and probe browser channels", () => {
  assert.deepEqual(
    policy.channels.map(({ id, classification }) => [id, classification]),
    [
      ["chrome-stable", "required"],
      ["chrome-beta", "probe"],
      ["edge-stable", "required"],
      ["safari-stable", "required"],
      ["safari-technology-preview", "probe"],
      ["firefox-release", "required"],
      ["firefox-nightly", "probe"],
    ],
  );
  assert.equal(policy.acceptanceWindowHours, 24);
  assert.equal(policy.headedSessionRequired, true);
});

test("capture records an unlocked headed shipping browser with exact tool versions", () => {
  const record = captureHostInventory({
    assetId: "FW-MAC-M2-01",
    platform: "darwin",
    osBuild: "macOS 26.0 (25A123)",
    displayServer: "WindowServer",
    session: {
      interactive: true,
      locked: false,
      remote: false,
      identifier: "console",
    },
    browsers: [browser],
    tools,
    policy,
    capturedAt: new Date("2026-07-29T08:00:00.000Z"),
  });
  assert.equal(record.headed, true);
  assert.deepEqual(record.prohibitedLaunchArgumentsPresent, []);
  assert.equal(record.browsers[0].version, browser.version);
  assert.equal(record.tools.playwright, policy.tools.playwright);
});

test("unsafe WebGPU, backend, blocklist, certificate, and software flags fail", () => {
  for (const argument of policy.prohibitedLaunchArguments) {
    assert.throws(
      () => assertSafeLaunchArguments([`${argument}=value`], policy),
      /prohibited browser launch arguments/u,
      argument,
    );
  }
});

test("required host capture fails for locked, remote, non-Wayland, old, or drifted tools", () => {
  const base = {
    assetId: "FW-LNX-I12-01",
    platform: "linux",
    osBuild: "Ubuntu 24.04.3 LTS",
    displayServer: "GNOME Wayland",
    session: {
      interactive: true,
      locked: false,
      remote: false,
      identifier: "4",
      type: "wayland",
      waylandDisplay: "wayland-0",
    },
    browsers: [browser],
    tools,
    policy,
  };
  assert.throws(
    () =>
      captureHostInventory({
        ...base,
        session: { ...base.session, locked: true },
      }),
    /unlocked local interactive session/u,
  );
  assert.throws(
    () =>
      captureHostInventory({
        ...base,
        displayServer: "X11",
        session: { ...base.session, type: "x11", waylandDisplay: "" },
      }),
    /GNOME Wayland/u,
  );
  assert.throws(
    () =>
      captureHostInventory({
        ...base,
        browsers: [{ ...browser, version: "112.0.0.0" }],
      }),
    /below policy major/u,
  );
  assert.throws(
    () =>
      captureHostInventory({
        ...base,
        tools: { ...tools, geckodriver: "0.35.0" },
      }),
    /must equal checked version/u,
  );
});

test("update window resolves exact versions, expires at 24 hours, and always closes", () => {
  const freezeEnforcement = enforcement("freeze", [browser]);
  const frozen = createUpdateWindow({
    assetId: "FW-MAC-M2-01",
    resolvedChannels: [{ id: browser.id, version: browser.version }],
    frozenAt: new Date("2026-07-29T08:00:00.000Z"),
    policy,
    enforcement: freezeEnforcement,
  });
  assertUpdateWindowActive(frozen, new Date("2026-07-30T07:59:59.000Z"));
  assert.throws(
    () => assertUpdateWindowActive(frozen, new Date("2026-07-30T08:00:00.001Z")),
    /24-hour maximum/u,
  );
  const closed = closeUpdateWindow(
    frozen,
    new Date("2026-07-29T09:00:00.000Z"),
    enforcement("unfreeze", [browser]),
  );
  assert.equal(closed.state, "unfrozen");
  assert.equal(closed.cleanupAttempted, true);
  assert.throws(() => assertUpdateWindowActive(closed), /not active/u);
});

test("macOS and Windows session state is observed instead of synthesized", () => {
  const mac = observeLiveSession("darwin", {
    environment: {},
    execute: (command) => {
      if (command === "/usr/bin/stat") return "forge3d\n";
      return '    "CGSSessionScreenIsLocked" = Yes\n';
    },
  });
  assert.deepEqual(mac, {
    interactive: true,
    locked: true,
    remote: false,
    identifier: "forge3d",
  });

  const windows = observeLiveSession("win32", {
    environment: {},
    execute: () =>
      JSON.stringify({
        interactive: true,
        locked: false,
        remote: false,
        identifier: "LAB\\forge3d",
      }),
  });
  assert.equal(windows.interactive, true);
  assert.equal(windows.locked, false);
  assert.equal(windows.identifier, "LAB\\forge3d");
});

test("update window invokes an absolute enforcement helper and validates its receipt", () => {
  const calls = [];
  const result = enforceHostUpdatePolicy({
    helper: "/opt/forge3d/bin/browser-update-control",
    operation: "freeze",
    assetId: "FW-MAC-M2-01",
    resolvedChannels: [browser],
    execute: (command, args) => {
      calls.push([command, args]);
      return JSON.stringify(enforcement("freeze", [browser]).receipt);
    },
  });
  assert.equal(result.receipt.osUpdates, "disabled");
  assert.equal(calls[0][0], "/opt/forge3d/bin/browser-update-control");
  assert.deepEqual(calls[0][1].slice(0, 3), [
    "freeze",
    "--asset-id",
    "FW-MAC-M2-01",
  ]);
  assert.throws(
    () =>
      createUpdateWindow({
        assetId: "FW-MAC-M2-01",
        resolvedChannels: [browser],
        policy,
      }),
    /enforcement was not proven/u,
  );
});

test("freeze attempts persist enough exact state for unconditional restoration", () => {
  const pending = createPendingUpdateWindow({
    assetId: "FW-MAC-M2-01",
    resolvedChannels: [browser],
    helper: "/opt/forge3d/bin/browser-update-control",
    attemptedAt: new Date("2026-07-29T08:00:00.000Z"),
  });
  assert.equal(pending.state, "freeze_attempted");
  assert.equal(pending.enforcement.freezeReceipt, null);
  const restored = closeUpdateWindow(
    pending,
    new Date("2026-07-29T09:00:00.000Z"),
    enforcement("unfreeze", [browser]),
  );
  assert.equal(restored.state, "unfrozen");
  assert.equal(restored.enforcement.restoreReceipt.osUpdates, "restored");
});

test("host runtime helper supplies versions while the trusted script observes OS and lock state", () => {
  const calls = [];
  const result = resolveHostRuntime({
    helper: inventoryHelper,
    helperSha256: inventoryHelperSha256,
    lane: "chrome-macos-m2",
    hostId: "FW-MAC-M2-01",
    policy,
    platform: "darwin",
    environment: {},
    now: new Date("2026-07-29T08:00:00.000Z"),
    execute: (command) => {
      calls.push(command);
      if (command === inventoryHelper) {
        return JSON.stringify({
          schemaVersion: 1,
          hostId: "FW-MAC-M2-01",
          lane: "chrome-macos-m2",
          platform: "darwin",
          displayServer: "WindowServer",
          browsers: [browser],
          tools,
          launchArguments: [],
        });
      }
      if (command === "/usr/bin/sw_vers") return "25A123\n";
      if (command === "/usr/bin/stat") return "forge3d\n";
      if (command === "/usr/sbin/ioreg") {
        return '    "CGSSessionScreenIsLocked" = No\n';
      }
      throw new Error(`unexpected command ${command}`);
    },
  });
  assert.equal(result.inventory.session.locked, false);
  assert.equal(result.inventory.osBuild, "macOS build 25A123");
  assert.deepEqual(result.resolvedChannels, [
    { id: browser.id, version: browser.version },
  ]);
  assert.deepEqual(calls, [
    inventoryHelper,
    "/usr/bin/sw_vers",
    "/usr/bin/stat",
    "/usr/sbin/ioreg",
  ]);
});

function enforcement(operation, channels) {
  const state = operation === "freeze" ? "disabled" : "restored";
  const observedAt =
    operation === "freeze"
      ? "2026-07-29T08:00:00.000Z"
      : "2026-07-29T09:00:00.000Z";
  return {
    helper: "/opt/forge3d/bin/browser-update-control",
    observedAt,
    receipt: {
      schemaVersion: 1,
      operation,
      assetId: "FW-MAC-M2-01",
      osUpdates: state,
      browserUpdates: channels.map(({ id, version }) => ({
        id,
        version,
        state,
      })),
      observedAt,
    },
  };
}
