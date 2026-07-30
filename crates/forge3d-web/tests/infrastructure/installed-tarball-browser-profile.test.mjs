import assert from "node:assert/strict";
import test from "node:test";

import { resolveInstalledTarballBrowserProfile } from "../../scripts/installed-tarball-browser-profile.mjs";

const platforms = ["win32", "darwin", "linux"];
const brandedUnsafeArguments = [
  "--enable-unsafe-webgpu",
  "--ignore-gpu-blocklist",
  "--enable-features=Vulkan",
  "--use-angle=d3d11",
];

for (const operatingSystem of platforms) {
  test(`required exact-tarball profile is unflagged branded Chrome on ${operatingSystem}`, () => {
    for (const browserChannel of [undefined, "chrome"]) {
      const profile = resolveInstalledTarballBrowserProfile({
        evidenceMode: "required",
        browserChannel,
        operatingSystem,
      });

      assert.deepEqual(profile, {
        project: "installed-tarball-chrome-stable",
        lane: "required",
        browserName: "chrome",
        browserChannel: "chrome",
        playwrightChannel: "chrome",
        launchArguments: [],
        runtimeResult: "PASS",
      });
      assert.equal(
        profile.launchArguments.some((argument) =>
          brandedUnsafeArguments.some(
            (prohibited) =>
              argument === prohibited || argument.startsWith(`${prohibited}=`),
          ),
        ),
        false,
      );
    }
  });

  test(`probe exact-tarball profile defaults to flagged bundled Chromium on ${operatingSystem}`, () => {
    const expectedLaunchArguments = [
      "--enable-unsafe-webgpu",
      ...(operatingSystem === "win32" ? ["--use-angle=d3d11"] : []),
    ];
    for (const browserChannel of [undefined, "bundled"]) {
      const profile = resolveInstalledTarballBrowserProfile({
        evidenceMode: "probe",
        browserChannel,
        operatingSystem,
      });

      assert.deepEqual(profile, {
        project: "installed-tarball-chromium-preflight",
        lane: "probe",
        browserName: "chromium",
        browserChannel: "playwright",
        playwrightChannel: null,
        launchArguments: expectedLaunchArguments,
        runtimeResult: "PROBE",
      });
    }
  });
}

test("explicit probe Chrome is labeled as a flagged Chrome preflight", () => {
  const profile = resolveInstalledTarballBrowserProfile({
    evidenceMode: "probe",
    browserChannel: "chrome",
    operatingSystem: "linux",
  });

  assert.deepEqual(profile, {
    project: "installed-tarball-chrome-preflight",
    lane: "probe",
    browserName: "chrome",
    browserChannel: "chrome",
    playwrightChannel: "chrome",
    launchArguments: ["--enable-unsafe-webgpu"],
    runtimeResult: "PROBE",
  });
});

test("required exact-tarball evidence rejects bundled Chromium", () => {
  assert.throws(
    () =>
      resolveInstalledTarballBrowserProfile({
        evidenceMode: "required",
        browserChannel: "bundled",
        operatingSystem: "win32",
      }),
    /required exact-tarball evidence cannot use bundled Chromium/u,
  );
});

test("exact-tarball profile rejects unknown modes and channels", () => {
  assert.throws(
    () =>
      resolveInstalledTarballBrowserProfile({
        evidenceMode: "pass",
        operatingSystem: "linux",
      }),
    /evidenceMode must be either required or probe/u,
  );
  assert.throws(
    () =>
      resolveInstalledTarballBrowserProfile({
        evidenceMode: "probe",
        browserChannel: "stable",
        operatingSystem: "linux",
      }),
    /FORGE3D_BROWSER_CHANNEL must be either chrome or bundled/u,
  );
});
