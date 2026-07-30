import { describe, expect, it } from "vitest";

import { serializePlaywrightLaunchArguments } from "../browser/webgpu-fixture";
import { collectPlaywrightLaunchDiagnostics } from "../browser/playwright-launch-diagnostics";
import type { Forge3DBrowserProjectMetadata } from "../browser/playwright-project-metadata";

const firefox: Forge3DBrowserProjectMetadata = {
  project: "firefox-preflight",
  browserName: "firefox",
  channel: "playwright",
  lane: "preflight",
  webgpuRequired: true,
  launchArgs: [],
  preferenceMode: "default",
  firefoxUserPrefs: {},
  supportLevel: "ENGINE_PASS",
};

const chromium: Forge3DBrowserProjectMetadata = {
  project: "chromium-preflight",
  browserName: "chromium",
  channel: "playwright",
  lane: "preflight",
  webgpuRequired: true,
  launchArgs: ["--enable-unsafe-webgpu"],
};

function browser(engine: string) {
  return {
    browserType: () => ({
      name: () => engine,
    }),
  };
}

describe("Playwright launch diagnostics", () => {
  it("records honest Firefox project configuration without invoking Chromium observation", async () => {
    let observerCalls = 0;
    const diagnostics = await collectPlaywrightLaunchDiagnostics(
      browser("firefox"),
      firefox,
      async () => {
        observerCalls += 1;
        throw new Error("Firefox must not call the Chromium observer");
      },
    );

    expect(observerCalls).toBe(0);
    expect(diagnostics).toMatchObject({
      declaredEngine: "firefox",
      actualEngine: "firefox",
      provenance: "project-configuration",
      configuredArguments: [],
      effectiveArguments: [],
      observationSource: "playwright-project-configuration",
      observed: false,
      browserProcessId: null,
      preferenceMode: "default",
      firefoxUserPrefs: {},
      supportLevel: "ENGINE_PASS",
      configuredLaunchFlagsPresent: false,
      effectiveLaunchFlagsPresent: false,
      configuredArgumentsObserved: true,
      preflightIdentityConsistent: true,
    });
  });

  it("fails before observation when the launched engine contradicts project metadata", async () => {
    let observerCalls = 0;
    await expect(
      collectPlaywrightLaunchDiagnostics(
        browser("chromium"),
        firefox,
        async () => {
          observerCalls += 1;
          throw new Error("observer must not run after an identity mismatch");
        },
      ),
    ).rejects.toThrow(
      /firefox-preflight declares firefox but launched chromium/u,
    );
    expect(observerCalls).toBe(0);
  });

  it("retains live Chromium provenance and effective launch arguments", async () => {
    const diagnostics = await collectPlaywrightLaunchDiagnostics(
      browser("chromium"),
      chromium,
      async () => ({
        effectiveLaunchArguments: [
          "--enable-automation",
          "--enable-unsafe-webgpu",
        ],
        launchArgumentsObserved: true,
        launchArgumentSource: "chromium-cdp-browser-command-line",
        browserProcessId: 4312,
      }),
    );

    expect(diagnostics).toMatchObject({
      declaredEngine: "chromium",
      actualEngine: "chromium",
      provenance: "live-browser",
      configuredArguments: ["--enable-unsafe-webgpu"],
      effectiveArguments: [
        "--enable-automation",
        "--enable-unsafe-webgpu",
      ],
      observationSource: "chromium-cdp-browser-command-line",
      observed: true,
      browserProcessId: 4312,
      configuredArgumentsObserved: true,
      preflightIdentityConsistent: true,
    });
    expect(
      serializePlaywrightLaunchArguments(chromium, diagnostics),
    ).toEqual({
      configuredArguments: ["--enable-unsafe-webgpu"],
      effectiveArguments: [
        "--enable-automation",
        "--enable-unsafe-webgpu",
      ],
    });
  });

  it("rejects Chromium observations that are not live browser proof", async () => {
    await expect(
      collectPlaywrightLaunchDiagnostics(
        browser("chromium"),
        chromium,
        async () => ({
          effectiveLaunchArguments: [],
          launchArgumentsObserved: false,
          launchArgumentSource: "playwright-project-configuration",
          browserProcessId: null,
        }),
      ),
    ).rejects.toThrow(/requires live Chromium launch provenance/u);
  });
});
