import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  installedPackageVersion,
  isPlaywrightSourceLaunchObservationConsistent,
  observeChromiumLaunch,
  observePlaywrightSourceLaunch,
  resolveInstalledAppiumDriverVersion,
  splitObservedCommandLine,
} from "../../scripts/browser-launch-provenance.mjs";
import { validateBrowserRunProvenance } from "../../scripts/browser-run-provenance.mjs";

const inventory = {
  schemaVersion: 1,
  assetId: "FW-WIN-I12-01",
  platform: "win32",
  osBuild: "Microsoft Windows NT 10.0.26200.0",
  headed: true,
  displayServer: "Desktop Window Manager",
  session: {
    interactive: true,
    locked: false,
    remote: false,
    identifier: "FORGE3D\\lab",
  },
  browsers: [
    {
      id: "chrome-stable",
      version: "150.0.7339.12",
      executable: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    },
  ],
  tools: { playwright: "1.56.1" },
  capturedAt: "2026-07-29T10:00:00.000Z",
};
const policy = {
  prohibitedLaunchArguments: ["--disable-gpu", "--use-angle"],
  tools: { playwright: "1.56.1" },
};

test("Chromium provenance comes from the live CDP browser command line", async () => {
  let detached = false;
  const result = await observeChromiumLaunch({
    newBrowserCDPSession: async () => ({
      send: async (method) =>
        method === "Browser.getBrowserCommandLine"
          ? {
              arguments: [
                inventory.browsers[0].executable,
                "--enable-automation",
                "--user-data-dir=C:\\Temp\\pw",
              ],
            }
          : { processInfo: [{ type: "browser", id: 4312 }] },
      detach: async () => {
        detached = true;
      },
    }),
  });
  assert.deepEqual(result.effectiveLaunchArguments, [
    "--enable-automation",
    "--user-data-dir=C:\\Temp\\pw",
  ]);
  assert.equal(result.browserProcessId, 4312);
  assert.equal(result.launchArgumentsObserved, true);
  assert.equal(detached, true);
});

test("WebKit source configuration never enters Chromium CDP or process observation", async () => {
  let cdpCalls = 0;
  const observation = await observePlaywrightSourceLaunch(
    {
      newBrowserCDPSession: async () => {
        cdpCalls += 1;
        throw new Error("WebKit must not request a Chromium CDP session");
      },
    },
    {
      project: "webkit-preflight",
      browserName: "webkit",
      channel: "playwright",
      lane: "preflight",
      launchObservation: "project-configuration",
      webgpuRequired: true,
      launchArgs: [],
    },
  );

  assert.equal(cdpCalls, 0);
  assert.deepEqual(observation, {
    effectiveLaunchArguments: [],
    launchArgumentsObserved: false,
    launchArgumentSource: "playwright-project-configuration",
    browserProcessId: null,
  });
  assert.equal(
    isPlaywrightSourceLaunchObservationConsistent(
      {
        launchObservation: "project-configuration",
        launchArgs: [],
      },
      observation,
    ),
    true,
  );
});

test("Chromium source observation rejects a fabricated non-live source", () => {
  assert.equal(
    isPlaywrightSourceLaunchObservationConsistent(
      {
        launchObservation: "chromium-live",
        launchArgs: ["--enable-unsafe-webgpu"],
      },
      {
        effectiveLaunchArguments: ["--enable-unsafe-webgpu"],
        launchArgumentsObserved: true,
        launchArgumentSource: "playwright-project-configuration",
        browserProcessId: null,
      },
    ),
    false,
  );
});

test("Chromium provenance falls back to the exact live process arguments when CDP denies command-line access", async () => {
  let detached = false;
  const readPaths = [];
  const result = await observeChromiumLaunch(
    {
      newBrowserCDPSession: async () => ({
        send: async (method) => {
          if (method === "SystemInfo.getProcessInfo") {
            return { processInfo: [{ type: "browser", id: 4312 }] };
          }
          throw new Error(
            "Command line not returned because --enable-automation not set",
          );
        },
        detach: async () => {
          detached = true;
        },
      }),
    },
    {
      platform: "linux",
      readFile: (path) => {
        readPaths.push(path);
        return Buffer.from(
          [
            "/usr/bin/chromium",
            "--enable-unsafe-webgpu",
            "--user-data-dir=/tmp/playwright profile",
            "",
          ].join("\0"),
        );
      },
    },
  );
  assert.deepEqual(readPaths, ["/proc/4312/cmdline"]);
  assert.deepEqual(result, {
    effectiveLaunchArguments: [
      "--enable-unsafe-webgpu",
      "--user-data-dir=/tmp/playwright profile",
    ],
    launchArgumentsObserved: true,
    launchArgumentSource: "linux-live-browser-process",
    browserProcessId: 4312,
  });
  assert.equal(detached, true);
});

test("macOS Chromium fallback strips the exact executable path with spaces and retains positional arguments", async () => {
  const executable =
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const invocations = [];
  const result = await observeChromiumLaunch(
    {
      newBrowserCDPSession: async () => ({
        send: async (method) => {
          if (method === "SystemInfo.getProcessInfo") {
            return { processInfo: [{ type: "browser", id: 9912 }] };
          }
          throw new Error(
            "Command line not returned because --enable-automation not set",
          );
        },
        detach: async () => {},
      }),
    },
    {
      platform: "darwin",
      execute: (command, args) => {
        invocations.push([command, args]);
        if (args.at(-1) === "comm=") return executable;
        return `${executable} --headless "--user-data-dir=/tmp/profile with spaces" about:blank`;
      },
    },
  );
  assert.deepEqual(invocations, [
    ["ps", ["-ww", "-p", "9912", "-o", "comm="]],
    ["ps", ["-ww", "-p", "9912", "-o", "command="]],
  ]);
  assert.deepEqual(result, {
    effectiveLaunchArguments: [
      "--headless",
      "--user-data-dir=/tmp/profile with spaces",
      "about:blank",
    ],
    launchArgumentsObserved: true,
    launchArgumentSource: "darwin-live-browser-process",
    browserProcessId: 9912,
  });
});

test("macOS Chromium fallback fails closed when executable and command observations disagree", async () => {
  await assert.rejects(
    () =>
      observeChromiumLaunch(
        {
          newBrowserCDPSession: async () => ({
            send: async (method) => {
              if (method === "SystemInfo.getProcessInfo") {
                return { processInfo: [{ type: "browser", id: 9912 }] };
              }
              throw new Error(
                "Command line not returned because --enable-automation not set",
              );
            },
            detach: async () => {},
          }),
        },
        {
          platform: "darwin",
          execute: (_command, args) =>
            args.at(-1) === "comm="
              ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
              : "/Applications/Other.app/Contents/MacOS/Other --headless",
        },
      ),
    /both CDP and the live browser process/u,
  );
});

test("Chromium provenance fails closed when neither CDP nor a live browser PID can prove arguments", async () => {
  let detached = false;
  await assert.rejects(
    () =>
      observeChromiumLaunch({
        newBrowserCDPSession: async () => ({
          send: async (method) => {
            if (method === "SystemInfo.getProcessInfo") {
              return { processInfo: [] };
            }
            throw new Error(
              "Command line not returned because --enable-automation not set",
            );
          },
          detach: async () => {
            detached = true;
          },
        }),
      }),
    /did not expose a live browser process ID/u,
  );
  assert.equal(detached, true);
});

test("checked automation version is read from the installed package record", () => {
  const directory = mkdtempSync(join(tmpdir(), "forge3d-playwright-version-"));
  try {
    const packageRoot = join(directory, "node_modules", "playwright");
    const modulePath = join(packageRoot, "lib", "index.mjs");
    mkdirSync(join(packageRoot, "lib"), { recursive: true });
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "playwright", version: "1.56.1" }),
    );
    writeFileSync(modulePath, "export const chromium = {};\n");
    assert.equal(
      installedPackageVersion(modulePath, ["playwright", "playwright-core"]),
      "1.56.1",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("installed Appium driver versions are resolved from supported CLI JSON shapes", () => {
  assert.equal(
    resolveInstalledAppiumDriverVersion(
      { xcuitest: { version: "9.8.1" } },
      "xcuitest",
    ),
    "9.8.1",
  );
  assert.equal(
    resolveInstalledAppiumDriverVersion(
      {
        drivers: [
          {
            pkgName: "appium-uiautomator2-driver",
            version: "5.1.0",
          },
        ],
      },
      "uiautomator2",
    ),
    "5.1.0",
  );
  assert.throws(
    () => resolveInstalledAppiumDriverVersion({ drivers: [] }, "xcuitest"),
    /installed Appium driver is missing/u,
  );
});

test("live Windows and POSIX command lines retain exact browser arguments", () => {
  assert.deepEqual(
    splitObservedCommandLine(
      '"C:\\Program Files\\Mozilla Firefox\\firefox.exe" -no-remote "-profile" "C:\\Lab Profile"',
      "win32",
    ),
    [
      "C:\\Program Files\\Mozilla Firefox\\firefox.exe",
      "-no-remote",
      "-profile",
      "C:\\Lab Profile",
    ],
  );
  assert.deepEqual(
    splitObservedCommandLine(
      "/usr/bin/firefox -no-remote -profile '/var/lib/forge3d/lab profile'",
      "linux",
    ),
    [
      "/usr/bin/firefox",
      "-no-remote",
      "-profile",
      "/var/lib/forge3d/lab profile",
    ],
  );
});

test("run provenance rejects placeholder drivers and prohibited observed flags", () => {
  const request = {
    runtime: {
      driver: "playwright-chrome",
      browser: "chrome",
      mobile: false,
    },
    session: {
      browser: {
        name: "chrome",
        channel: "stable",
        version: "150.0.7339.12",
      },
      driverVersion: "1.56.1",
      effectiveLaunchArguments: ["--enable-automation"],
      launchArgumentsObserved: true,
      launchArgumentSource: "chromium-cdp-browser-command-line",
      browserProcessId: 4312,
    },
    inventory,
    hostId: inventory.assetId,
    platform: inventory.platform,
    browserPolicy: policy,
  };
  const result = validateBrowserRunProvenance(request);
  assert.equal(result.driver.version, "1.56.1");
  assert.equal(result.system.osBuild, inventory.osBuild);
  assert.equal(
    validateBrowserRunProvenance({
      ...request,
      session: {
        ...request.session,
        launchArgumentSource: "win32-live-browser-process",
      },
    }).launchObservation.source,
    "win32-live-browser-process",
  );
  assert.throws(
    () =>
      validateBrowserRunProvenance({
        ...request,
        session: { ...request.session, driverVersion: "checked-playwright" },
      }),
    /exact runtime provenance/u,
  );
  assert.throws(
    () =>
      validateBrowserRunProvenance({
        ...request,
        session: {
          ...request.session,
          effectiveLaunchArguments: ["--disable-gpu"],
        },
      }),
    /prohibited browser launch arguments/u,
  );
  assert.throws(
    () =>
      validateBrowserRunProvenance({
        ...request,
        session: {
          ...request.session,
          launchArgumentSource: "linux-live-browser-process",
        },
      }),
    /exact runtime provenance/u,
  );
});
