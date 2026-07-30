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
  return {
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
