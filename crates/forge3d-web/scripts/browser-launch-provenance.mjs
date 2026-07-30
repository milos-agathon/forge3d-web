import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export async function observeChromiumLaunch(
  browser,
  {
    platform = process.platform,
    execute = execFileSync,
    readFile = readFileSync,
  } = {},
) {
  const session = await browser.newBrowserCDPSession();
  try {
    const processInfo = await session
      .send("SystemInfo.getProcessInfo")
      .catch(() => ({ processInfo: [] }));
    const browserProcess = processInfo.processInfo?.find(
      ({ type }) => type === "browser",
    );
    try {
      const commandLine = await session.send("Browser.getBrowserCommandLine");
      if (
        !Array.isArray(commandLine.arguments) ||
        commandLine.arguments.length < 1 ||
        commandLine.arguments.some((value) => typeof value !== "string")
      ) {
        throw new Error(
          "Chromium CDP did not return its effective command line",
        );
      }
      return {
        effectiveLaunchArguments: commandLine.arguments.slice(1),
        launchArgumentsObserved: true,
        launchArgumentSource: "chromium-cdp-browser-command-line",
        browserProcessId: browserProcess?.id ?? null,
      };
    } catch (cdpError) {
      const processId = Number(browserProcess?.id);
      if (!Number.isInteger(processId) || processId < 1) {
        throw new Error(
          "Chromium CDP command-line observation failed and did not expose a live browser process ID",
          { cause: cdpError },
        );
      }
      try {
        return observeProcessLaunch({
          processId,
          platform,
          execute,
          readFile,
        });
      } catch (processError) {
        throw new AggregateError(
          [cdpError, processError],
          "Chromium launch provenance failed through both CDP and the live browser process",
        );
      }
    }
  } finally {
    await session.detach();
  }
}

export async function observePlaywrightSourceLaunch(
  browser,
  project,
  {
    observeChromium = observeChromiumLaunch,
  } = {},
) {
  if (project.launchObservation === "chromium-live") {
    return observeChromium(browser);
  }
  if (project.launchObservation !== "project-configuration") {
    throw new Error(
      `unsupported source launch observation mode: ${project.launchObservation}`,
    );
  }
  if (
    !Array.isArray(project.launchArgs) ||
    project.launchArgs.length !== 0
  ) {
    throw new Error(
      `${project.project} configuration-only launch proof requires zero launch arguments`,
    );
  }
  return {
    effectiveLaunchArguments: [],
    launchArgumentsObserved: false,
    launchArgumentSource: "playwright-project-configuration",
    browserProcessId: null,
  };
}

export function isPlaywrightSourceLaunchObservationConsistent(
  project,
  observation,
  platform = process.platform,
) {
  if (observation === undefined) {
    return false;
  }
  if (project.launchObservation === "chromium-live") {
    return (
      observation.launchArgumentsObserved === true &&
      Array.isArray(observation.effectiveLaunchArguments) &&
      observation.effectiveLaunchArguments.length > 0 &&
      isLiveChromiumLaunchArgumentSource(
        observation.launchArgumentSource,
        platform,
      )
    );
  }
  return (
    project.launchObservation === "project-configuration" &&
    Array.isArray(project.launchArgs) &&
    project.launchArgs.length === 0 &&
    observation.launchArgumentsObserved === false &&
    observation.launchArgumentSource ===
      "playwright-project-configuration" &&
    observation.browserProcessId === null &&
    Array.isArray(observation.effectiveLaunchArguments) &&
    observation.effectiveLaunchArguments.length === 0
  );
}

export function isLiveChromiumLaunchArgumentSource(
  source,
  platform = process.platform,
) {
  return (
    source === "chromium-cdp-browser-command-line" ||
    source === `${platform}-live-browser-process`
  );
}

export function observeWebDriverLaunch({
  runtime,
  session,
  platform = process.platform,
  execute = execFileSync,
  readFile = readFileSync,
}) {
  if (runtime.driver === "selenium-firefox") {
    const processId = Number(session.capabilities["moz:processID"]);
    if (!Number.isInteger(processId) || processId < 1) {
      throw new Error("Firefox WebDriver did not expose its browser process ID");
    }
    return observeProcessLaunch({ processId, platform, execute, readFile });
  }
  if (runtime.driver === "safaridriver") {
    const output = execute("pgrep", ["-x", "Safari"], {
      encoding: "utf8",
    }).trim();
    const processIds = output
      .split(/\s+/u)
      .filter(Boolean)
      .map(Number)
      .filter((value) => Number.isInteger(value) && value > 0);
    if (processIds.length !== 1) {
      throw new Error("Safari launch provenance did not resolve one main process");
    }
    return observeProcessLaunch({
      processId: processIds[0],
      platform,
      execute,
      readFile,
    });
  }
  throw new Error(`unsupported WebDriver provenance source: ${runtime.driver}`);
}

export function observeAppiumLaunch({ runtime, session }) {
  const optionKeys =
    runtime.driver === "appium-uiautomator2"
      ? ["goog:chromeOptions", "appium:chromeOptions"]
      : ["safari:processArguments", "appium:processArguments"];
  let effectiveLaunchArguments = [];
  for (const key of optionKeys) {
    const value = session.capabilities[key];
    if (value?.args !== undefined) {
      if (
        !Array.isArray(value.args) ||
        value.args.some((argument) => typeof argument !== "string")
      ) {
        throw new Error("Appium returned malformed effective browser arguments");
      }
      effectiveLaunchArguments = [...value.args];
      break;
    }
  }
  return {
    effectiveLaunchArguments,
    launchArgumentsObserved: true,
    launchArgumentSource: "appium-effective-session-capabilities",
    browserProcessId: null,
  };
}

export function installedPackageVersion(modulePath, expectedNames) {
  let directory = dirname(resolve(modulePath));
  for (;;) {
    const packagePath = resolve(directory, "package.json");
    if (existsSync(packagePath)) {
      const record = JSON.parse(readFileSync(packagePath, "utf8"));
      if (expectedNames.includes(record.name)) {
        if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u.test(record.version)) {
          throw new Error("automation package version is malformed");
        }
        return record.version;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error("automation module is not inside its checked package");
}

export function resolveInstalledAppiumDriverVersion(record, driverName) {
  const collections = [record, record?.drivers, record?.installed].filter(
    Boolean,
  );
  for (const collection of collections) {
    if (Array.isArray(collection)) {
      const match = collection.find(
        (entry) =>
          entry?.name === driverName ||
          entry?.driverName === driverName ||
          entry?.pkgName?.endsWith(`appium-${driverName}-driver`),
      );
      if (typeof match?.version === "string") return match.version;
    } else {
      const entry = collection[driverName];
      if (typeof entry?.version === "string") return entry.version;
    }
  }
  throw new Error(`installed Appium driver is missing: ${driverName}`);
}

export function splitObservedCommandLine(commandLine, platform) {
  if (typeof commandLine !== "string" || commandLine.trim() === "") {
    throw new Error("browser process command line is empty");
  }
  return platform === "win32"
    ? splitWindowsCommandLine(commandLine)
    : splitPosixCommandLine(commandLine);
}

function observeProcessLaunch({ processId, platform, execute, readFile }) {
  let tokens;
  if (platform === "win32") {
    const commandLine = JSON.parse(
      execute(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${processId}"; if ($null -eq $p) { throw "missing process" }; $p.CommandLine | ConvertTo-Json -Compress`,
        ],
        { encoding: "utf8" },
      ),
    );
    tokens = splitObservedCommandLine(commandLine, platform);
  } else if (platform === "linux") {
    tokens = parseNullSeparatedArguments(
      readFile(`/proc/${processId}/cmdline`),
    );
  } else if (platform === "darwin") {
    const executable = execute(
      "ps",
      ["-ww", "-p", String(processId), "-o", "comm="],
      {
        encoding: "utf8",
      },
    ).trim();
    const commandLine = execute(
      "ps",
      ["-ww", "-p", String(processId), "-o", "command="],
      {
        encoding: "utf8",
      },
    ).trim();
    if (
      executable === "" ||
      (commandLine !== executable &&
        !commandLine.startsWith(`${executable} `))
    ) {
      throw new Error(
        "macOS browser command line does not match its observed executable path",
      );
    }
    const argumentText = commandLine.slice(executable.length).trimStart();
    tokens = [
      executable,
      ...(argumentText === ""
        ? []
        : splitObservedCommandLine(argumentText, platform)),
    ];
  } else {
    throw new Error(`unsupported browser process platform: ${platform}`);
  }
  if (tokens.length < 1) {
    throw new Error("browser process command line has no executable");
  }
  return {
    effectiveLaunchArguments: tokens.slice(1),
    launchArgumentsObserved: true,
    launchArgumentSource: `${platform}-live-browser-process`,
    browserProcessId: processId,
  };
}

export function parseNullSeparatedArguments(bytes) {
  if (!Buffer.isBuffer(bytes)) {
    throw new Error("browser process argument bytes are unavailable");
  }
  return bytes
    .toString("utf8")
    .split("\0")
    .filter((value) => value !== "");
}

function splitPosixCommandLine(value) {
  const result = [];
  let token = "";
  let quote = null;
  let escaped = false;
  const push = () => {
    if (token !== "") result.push(token);
    token = "";
  };
  for (const character of value.trim()) {
    if (escaped) {
      token += character;
      escaped = false;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = null;
      else token += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/u.test(character)) {
      push();
    } else {
      token += character;
    }
  }
  if (escaped || quote) throw new Error("browser process command line is malformed");
  push();
  return result;
}

function splitWindowsCommandLine(value) {
  const result = [];
  let index = 0;
  while (index < value.length) {
    while (/\s/u.test(value[index] ?? "")) index += 1;
    if (index >= value.length) break;
    let token = "";
    let quoted = false;
    while (index < value.length && (quoted || !/\s/u.test(value[index]))) {
      let slashes = 0;
      while (value[index] === "\\") {
        slashes += 1;
        index += 1;
      }
      if (value[index] === '"') {
        token += "\\".repeat(Math.floor(slashes / 2));
        if (slashes % 2 === 0) quoted = !quoted;
        else token += '"';
        index += 1;
      } else {
        token += "\\".repeat(slashes);
        if (index < value.length) token += value[index++];
      }
    }
    if (quoted) throw new Error("Windows browser command line is malformed");
    result.push(token);
  }
  return result;
}
