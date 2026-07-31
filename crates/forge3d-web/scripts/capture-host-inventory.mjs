import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultPolicyPath = join(
  packageRoot,
  "tests",
  "infrastructure",
  "browser-policy.json",
);

export function captureHostInventory({
  assetId,
  platform,
  osBuild,
  displayServer,
  session,
  browsers,
  tools,
  launchArguments = [],
  capturedAt = new Date(),
  policy,
  hardware = null,
  matrix = null,
  trackpad = null,
  requireExactHardware = false,
  requireTrackpad = false,
}) {
  if (!/^FW-(?:MAC|WIN|LNX)-[A-Z0-9-]+$/u.test(assetId ?? "")) {
    throw new Error("assetId must identify a fixed browser-lab host");
  }
  if (!["darwin", "win32", "linux"].includes(platform)) {
    throw new Error(`unsupported host platform: ${platform}`);
  }
  validateHeadedSession({ platform, displayServer, session, policy });
  const normalizedArguments = launchArguments.map(String);
  assertSafeLaunchArguments(normalizedArguments, policy);
  const browserRecords = browsers.map((browser) =>
    validateBrowserRecord(browser, policy),
  );
  const toolRecords = validateToolVersions(tools, policy, platform);
  const baseInventory = {
    schemaVersion: 1,
    assetId,
    platform,
    osBuild: nonEmpty(osBuild, "osBuild"),
    headed: true,
    displayServer: nonEmpty(displayServer, "displayServer"),
    session: {
      interactive: true,
      locked: false,
      remote: false,
      identifier: nonEmpty(session.identifier, "session.identifier"),
    },
    browsers: browserRecords,
    tools: toolRecords,
    effectiveLaunchArguments: normalizedArguments,
    prohibitedLaunchArgumentsPresent: [],
    capturedAt: new Date(capturedAt).toISOString(),
  };
  if (!requireExactHardware) return baseInventory;
  if (!hardware || !matrix || !Array.isArray(hardware.attachedAssets)) {
    throw new Error(
      "exact host inventory requires explicit hardware, attachment, and matrix observations",
    );
  }
  assertNoStableIdentifiers(hardware);
  assertExactKeys(hardware, [
    "model",
    "cpu",
    "gpu",
    "ramGiB",
    "attachedAssets",
  ], "observed hardware");
  const attachedAssets = hardware.attachedAssets.map((asset, index) => {
    assertExactKeys(
      asset,
      ["assetId", "model", "appiumId"],
      `observed attachment ${index}`,
    );
    return {
      assetId: nonEmpty(asset.assetId, `attachedAssets[${index}].assetId`),
      model: nonEmpty(asset.model, `attachedAssets[${index}].model`),
      appiumId:
        asset.appiumId === null
          ? null
          : nonEmpty(asset.appiumId, `attachedAssets[${index}].appiumId`),
    };
  });
  const inventory = {
    ...baseInventory,
    model: nonEmpty(hardware.model, "hardware.model"),
    cpu: nonEmpty(hardware.cpu, "hardware.cpu"),
    gpu: nonEmpty(hardware.gpu, "hardware.gpu"),
    ramGiB: hardware.ramGiB,
    attachedAssetIds: attachedAssets.map(({ assetId: attachedId }) => attachedId),
    attachedAssets,
    trackpad,
  };
  validateHostInventory(inventory, { matrix, requireTrackpad });
  return inventory;
}

export function validateHostInventory(
  inventory,
  { matrix, requireTrackpad = false } = {},
) {
  assertNoStableIdentifiers(inventory);
  assertExactKeys(
    inventory,
    [
      "schemaVersion",
      "assetId",
      "platform",
      "model",
      "cpu",
      "gpu",
      "ramGiB",
      "osBuild",
      "headed",
      "displayServer",
      "session",
      "browsers",
      "tools",
      "effectiveLaunchArguments",
      "prohibitedLaunchArgumentsPresent",
      "capturedAt",
      "attachedAssetIds",
      "attachedAssets",
      "trackpad",
    ],
    "host inventory",
  );
  const host = matrix?.hosts?.find(
    (candidate) => candidate.assetId === inventory?.assetId,
  );
  const expectedPlatform = {
    macOS: "darwin",
    Windows: "win32",
    Ubuntu: "linux",
  }[host?.os?.family];
  if (
    inventory.schemaVersion !== 1 ||
    !host ||
    inventory.platform !== expectedPlatform ||
    inventory.model !== host.model ||
    inventory.cpu !== host.cpu ||
    inventory.gpu !== host.gpu ||
    inventory.ramGiB !== host.ramGiB ||
    inventory.displayServer !== host.displayServer ||
    inventory.headed !== true ||
    inventory.session?.interactive !== true ||
    inventory.session.locked !== false ||
    inventory.session.remote !== false ||
    !nonEmptyOrFalse(inventory.osBuild) ||
    !nonEmptyOrFalse(inventory.session.identifier) ||
    !isCanonicalTimestamp(inventory.capturedAt) ||
    !Array.isArray(inventory.browsers) ||
    inventory.browsers.length === 0 ||
    !Array.isArray(inventory.effectiveLaunchArguments) ||
    !Array.isArray(inventory.prohibitedLaunchArgumentsPresent) ||
    inventory.prohibitedLaunchArgumentsPresent.length !== 0
  ) {
    throw new Error("host inventory does not match the checked physical host");
  }
  assertExactKeys(
    inventory.session,
    ["interactive", "locked", "remote", "identifier"],
    "host inventory session",
  );
  for (const [index, browser] of inventory.browsers.entries()) {
    assertExactKeys(
      browser,
      ["id", "channel", "classification", "automation", "version", "executable"],
      `host inventory browser ${index}`,
    );
  }
  assertInventoryTools(inventory.tools);
  validateAttachedAssets(inventory, host, matrix);
  validateTrackpad(inventory.trackpad, matrix, {
    required: requireTrackpad,
    expectedHostId: host.assetId,
  });
  return inventory;
}

export function observeLiveSession(
  platform,
  {
    execute = execFileSync,
    environment = process.env,
  } = {},
) {
  if (platform === "linux") {
    const sessionId = environment.XDG_SESSION_ID;
    if (!sessionId) {
      return {
        interactive: false,
        locked: true,
        remote: environment.SSH_CONNECTION !== undefined,
        identifier: "",
        type: environment.XDG_SESSION_TYPE,
        waylandDisplay: environment.WAYLAND_DISPLAY,
      };
    }
    const property = (name) =>
      execute(
        "loginctl",
        ["show-session", sessionId, `--property=${name}`, "--value"],
        { encoding: "utf8" },
      ).trim();
    return {
      interactive: property("Active") === "yes",
      locked: property("LockedHint") === "yes",
      remote:
        property("Remote") === "yes" ||
        environment.SSH_CONNECTION !== undefined,
      identifier: sessionId,
      type: property("Type") || environment.XDG_SESSION_TYPE,
      waylandDisplay: environment.WAYLAND_DISPLAY,
    };
  }
  if (platform === "darwin") {
    const consoleUser = execute(
      "/usr/bin/stat",
      ["-f", "%Su", "/dev/console"],
      { encoding: "utf8" },
    ).trim();
    const rootSession = execute(
      "/usr/sbin/ioreg",
      ["-n", "Root", "-d1"],
      { encoding: "utf8" },
    );
    return {
      interactive:
        consoleUser !== "" &&
        consoleUser !== "root" &&
        consoleUser !== "loginwindow",
      locked: /"CGSSessionScreenIsLocked"\s*=\s*(?:Yes|true|1)/u.test(
        rootSession,
      ),
      remote:
        environment.SSH_CONNECTION !== undefined ||
        environment.SSH_CLIENT !== undefined,
      identifier: consoleUser,
    };
  }
  if (platform === "win32") {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$computer = Get-CimInstance Win32_ComputerSystem",
      "$console = (query session 2>$null | Select-String '\\sconsole\\s+[^\\r\\n]*\\sActive\\s')",
      "$locked = [bool](Get-Process LogonUI -ErrorAction SilentlyContinue)",
      "$remote = [bool](query session 2>$null | Select-String '\\srdp-[^\\s]*\\s+[^\\r\\n]*\\sActive\\s')",
      "[pscustomobject]@{ interactive = [bool]$console -and [bool]$computer.UserName; locked = $locked; remote = $remote; identifier = [string]$computer.UserName } | ConvertTo-Json -Compress",
    ].join("; ");
    const observed = JSON.parse(
      execute(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { encoding: "utf8" },
      ),
    );
    return {
      interactive: observed.interactive === true,
      locked: observed.locked === true,
      remote:
        observed.remote === true ||
        environment.SSH_CONNECTION !== undefined ||
        environment.SSH_CLIENT !== undefined,
      identifier: String(observed.identifier ?? ""),
    };
  }
  throw new Error(`unsupported host platform: ${platform}`);
}

export function assertSafeLaunchArguments(argumentsList, policy) {
  const prohibited = new Set(policy.prohibitedLaunchArguments);
  const matches = argumentsList.filter((argument) => {
    const option = String(argument).split("=", 1)[0];
    return prohibited.has(option);
  });
  if (matches.length > 0) {
    throw new Error(`prohibited browser launch arguments: ${matches.join(", ")}`);
  }
}

function validateHeadedSession({ platform, displayServer, session, policy }) {
  if (!policy.headedSessionRequired) {
    throw new Error("browser policy must require headed sessions");
  }
  if (
    !session ||
    session.interactive !== true ||
    session.locked !== false ||
    session.remote !== false
  ) {
    throw new Error("browser acceptance requires an unlocked local interactive session");
  }
  if (platform === "linux") {
    if (session.type !== "wayland" || !String(displayServer).includes("Wayland")) {
      throw new Error("Linux browser acceptance requires a real GNOME Wayland session");
    }
    if (!session.waylandDisplay) {
      throw new Error("WAYLAND_DISPLAY is required for Linux browser acceptance");
    }
  }
}

function validateBrowserRecord(browser, policy) {
  const entry = policy.channels.find((candidate) => candidate.id === browser.id);
  if (!entry) {
    throw new Error(`browser channel is not checked by policy: ${browser.id}`);
  }
  const version = nonEmpty(browser.version, `${browser.id}.version`);
  const major = parseMajor(version);
  if (major < entry.minimumMajor) {
    throw new Error(
      `${browser.id} ${version} is below policy major ${entry.minimumMajor}`,
    );
  }
  if (
    browser.channel !== entry.channel ||
    browser.classification !== entry.classification ||
    browser.automation !== entry.automation
  ) {
    throw new Error(`${browser.id} metadata does not match checked policy`);
  }
  return {
    id: browser.id,
    channel: entry.channel,
    classification: entry.classification,
    automation: entry.automation,
    version,
    executable: nonEmpty(browser.executable, `${browser.id}.executable`),
  };
}

function validateToolVersions(tools, policy, platform) {
  const expected = policy.tools;
  const result = {};
  const requiredTools = ["playwright", "selenium", "geckodriver"];
  if (platform === "darwin") {
    requiredTools.push("appium", "appiumUiAutomator2", "appiumXcuitest");
  }
  for (const key of requiredTools) {
    if (tools[key] !== expected[key]) {
      throw new Error(`${key} must equal checked version ${expected[key]}`);
    }
    result[key] = tools[key];
  }
  if (platform === "darwin") {
    if (tools.safaridriverPath !== expected.safaridriverPath) {
      throw new Error(`safaridriver must be ${expected.safaridriverPath}`);
    }
    result.safaridriverPath = tools.safaridriverPath;
    result.safaridriverVersion = nonEmpty(
      tools.safaridriverVersion,
      "safaridriverVersion",
    );
  }
  return result;
}

function validateAttachedAssets(inventory, host, matrix) {
  if (
    !Array.isArray(inventory.attachedAssetIds) ||
    !Array.isArray(inventory.attachedAssets)
  ) {
    throw new Error("host inventory must explicitly contain its attachment set");
  }
  const ids = inventory.attachedAssetIds;
  const recordIds = inventory.attachedAssets.map((asset) => asset?.assetId);
  if (
    new Set(ids).size !== ids.length ||
    new Set(recordIds).size !== recordIds.length ||
    !sameSet(ids, host.attachedAssetIds) ||
    !sameSet(ids, recordIds)
  ) {
    throw new Error("host inventory attachment IDs do not match the checked exact set");
  }
  for (const [index, record] of inventory.attachedAssets.entries()) {
    assertExactKeys(
      record,
      ["assetId", "model", "appiumId"],
      `host inventory attachment ${index}`,
    );
    const expected = matrix.assets.find(
      (asset) => asset.assetId === record.assetId,
    );
    if (
      !expected ||
      expected.hostAssetId !== host.assetId ||
      record.model !== expected.model ||
      record.appiumId !== expected.appiumId
    ) {
      throw new Error(
        `host inventory attachment does not match the checked matrix: ${record.assetId ?? "<missing>"}`,
      );
    }
  }
}

function validateTrackpad(trackpad, matrix, { required, expectedHostId }) {
  if (!required) {
    if (trackpad !== null) {
      throw new Error("trackpad inventory is only valid for its required Mac path");
    }
    return;
  }
  const expected = matrix.assets.find(
    (asset) => asset.assetId === "FW-TRACKPAD-01",
  );
  assertNoStableIdentifiers(trackpad);
  assertExactKeys(
    trackpad,
    [
      "assetId",
      "model",
      "firmware",
      "transport",
      "batteryState",
      "capturedAt",
      "topology",
    ],
    "trackpad inventory",
  );
  assertExactKeys(
    trackpad?.topology,
    ["pairingAndCharging", "gestures", "hubPresent"],
    "trackpad topology",
  );
  if (
    expectedHostId !== "FW-MAC-M2-01" ||
    expected?.hostAssetId !== expectedHostId ||
    trackpad.assetId !== expected.assetId ||
    trackpad.model !== expected.model ||
    !nonEmptyOrFalse(trackpad.firmware) ||
    trackpad.transport !== "Bluetooth" ||
    !/^(?:unknown|(?:100|[0-9]{1,2})%)$/u.test(trackpad.batteryState ?? "") ||
    !isCanonicalTimestamp(trackpad.capturedAt) ||
    trackpad.topology.pairingAndCharging !== "direct-usb-c-to-usb-c" ||
    trackpad.topology.gestures !== "bluetooth" ||
    trackpad.topology.hubPresent !== false
  ) {
    throw new Error("trackpad inventory does not prove the fixed direct topology");
  }
}

function assertInventoryTools(tools) {
  const allowed = new Set([
    "playwright",
    "selenium",
    "geckodriver",
    "appium",
    "appiumUiAutomator2",
    "appiumXcuitest",
    "safaridriverPath",
    "safaridriverVersion",
  ]);
  if (
    !tools ||
    typeof tools !== "object" ||
    Array.isArray(tools) ||
    ["playwright", "selenium", "geckodriver"].some(
      (name) => !nonEmptyOrFalse(tools[name]),
    ) ||
    Object.entries(tools).some(
      ([name, value]) => !allowed.has(name) || !nonEmptyOrFalse(value),
    )
  ) {
    throw new Error("host inventory tools are incomplete or contain unknown fields");
  }
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`${label} fields do not match the checked contract`);
  }
}

export function assertNoStableIdentifiers(value) {
  visit(value);

  function visit(current) {
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (current === null || typeof current !== "object") return;
    for (const [key, nested] of Object.entries(current)) {
      const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
      if (
        /(?:serial|udid|bluetoothaddress|deviceaddress|locationid)/u.test(
          normalized,
        )
      ) {
        throw new Error("host inventory contains a forbidden stable identifier");
      }
      if (
        typeof nested === "string" &&
        normalized !== "fingerprint256" &&
        /\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/iu.test(nested)
      ) {
        throw new Error("host inventory contains a forbidden stable identifier");
      }
      visit(nested);
    }
  }
}

function sameSet(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  );
}

function nonEmptyOrFalse(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isCanonicalTimestamp(value) {
  if (!nonEmptyOrFalse(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function parseMajor(version) {
  const match = String(version).match(/^([0-9]+)(?:\.|$)/u);
  if (!match) {
    throw new Error(`invalid browser version: ${version}`);
  }
  return Number(match[1]);
}

function nonEmpty(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function parseArguments(argv) {
  const result = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || result.has(key)) {
      throw new Error(`invalid or duplicate argument near ${key ?? "<end>"}`);
    }
    result.set(key, value);
  }
  return result;
}

export function observeLiveOsBuild(
  platform,
  { execute = execFileSync } = {},
) {
  if (platform === "win32") {
    return execute(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$v = Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion'; \"$($v.ProductName) $($v.DisplayVersion) build $($v.CurrentBuild).$($v.UBR)\"",
      ],
      { encoding: "utf8" },
    ).trim();
  }
  if (platform === "darwin") {
    return `macOS build ${execute(
      "/usr/bin/sw_vers",
      ["-buildVersion"],
      { encoding: "utf8" },
    ).trim()}`;
  }
  return execute("uname", ["-a"], { encoding: "utf8" }).trim();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArguments(process.argv.slice(2));
  const outputPath = args.get("--output");
  const resolvedPath = args.get("--resolved-json");
  if (!outputPath || !resolvedPath || !args.get("--asset-id")) {
    throw new Error("--output, --resolved-json, and --asset-id are required");
  }
  const policy = JSON.parse(
    readFileSync(args.get("--policy") ?? defaultPolicyPath, "utf8"),
  );
  const resolved = JSON.parse(readFileSync(resolvedPath, "utf8"));
  if (resolved.platform && resolved.platform !== process.platform) {
    throw new Error("resolved inventory platform disagrees with the live host");
  }
  const platform = process.platform;
  const inventory = captureHostInventory({
    ...resolved,
    assetId: args.get("--asset-id"),
    platform,
    osBuild: observeLiveOsBuild(platform),
    session: observeLiveSession(platform),
    policy,
  });
  writeFileSync(outputPath, `${JSON.stringify(inventory, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(JSON.stringify({ ok: true, output: outputPath }));
}
