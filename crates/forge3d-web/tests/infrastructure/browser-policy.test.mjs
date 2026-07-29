import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertSafeLaunchArguments,
  captureHostInventory,
} from "../../scripts/capture-host-inventory.mjs";
import {
  assertUpdateWindowActive,
  closeUpdateWindow,
  createUpdateWindow,
} from "../../scripts/manage-browser-update-window.mjs";

const root = dirname(fileURLToPath(import.meta.url));
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
  const frozen = createUpdateWindow({
    assetId: "FW-MAC-M2-01",
    resolvedChannels: [{ id: browser.id, version: browser.version }],
    frozenAt: new Date("2026-07-29T08:00:00.000Z"),
    policy,
  });
  assertUpdateWindowActive(frozen, new Date("2026-07-30T07:59:59.000Z"));
  assert.throws(
    () => assertUpdateWindowActive(frozen, new Date("2026-07-30T08:00:00.001Z")),
    /24-hour maximum/u,
  );
  const closed = closeUpdateWindow(
    frozen,
    new Date("2026-07-29T09:00:00.000Z"),
  );
  assert.equal(closed.state, "unfrozen");
  assert.equal(closed.cleanupAttempted, true);
  assert.throws(() => assertUpdateWindowActive(closed), /not active/u);
});
