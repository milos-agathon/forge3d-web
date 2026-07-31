import { describe, expect, it } from "vitest";

import {
  configuredLaunchArgumentsObserved,
  launchFlagPresence,
  launchFlagsPresent,
  preflightLaunchIdentityConsistent,
  readForge3DBrowserProjectMetadata,
  resolveSourceBenchmarkEvidenceMode,
  resolveWebGpuRequired,
} from "../browser/playwright-project-metadata";

const chrome = {
  project: "chrome-stable",
  browserName: "chrome",
  channel: "chrome",
  lane: "branded",
  launchObservation: "chromium-live",
  webgpuRequired: false,
  launchArgs: [],
} as const;

const preflight = {
  project: "chromium-preflight",
  browserName: "chromium",
  channel: "playwright",
  lane: "preflight",
  launchObservation: "chromium-live",
  webgpuRequired: false,
  launchArgs: ["--enable-unsafe-webgpu", "--use-angle=d3d11"],
} as const;

const firefoxPreflight = {
  project: "firefox-preflight",
  browserName: "firefox",
  channel: "playwright",
  lane: "preflight",
  launchObservation: "project-configuration",
  webgpuRequired: true,
  launchArgs: [],
  preferenceMode: "default",
  firefoxUserPrefs: {},
  supportLevel: "ENGINE_PASS",
} as const;

const firefoxExperimental = {
  project: "firefox-nightly-experimental",
  browserName: "firefox",
  channel: "playwright",
  lane: "experimental",
  launchObservation: "project-configuration",
  webgpuRequired: false,
  launchArgs: [],
  preferenceMode: "override",
  firefoxUserPrefs: {
    "dom.webgpu.enabled": true,
  },
  supportLevel: "NOT_PROVEN",
} as const;

const webkit = {
  project: "webkit-preflight",
  browserName: "webkit",
  channel: "playwright",
  lane: "preflight",
  launchObservation: "project-configuration",
  webgpuRequired: true,
  launchArgs: [],
} as const;

describe("Playwright browser diagnostics metadata", () => {
  it("derives source benchmark evidence from the executing project lane", () => {
    expect(
      resolveSourceBenchmarkEvidenceMode(preflight, undefined),
    ).toBe("probe");
    expect(
      resolveSourceBenchmarkEvidenceMode(preflight, "probe"),
    ).toBe("probe");
    expect(
      resolveSourceBenchmarkEvidenceMode(chrome, undefined),
    ).toBe("required");
    expect(
      resolveSourceBenchmarkEvidenceMode(chrome, "required"),
    ).toBe("required");
    expect(
      resolveSourceBenchmarkEvidenceMode(firefoxPreflight, undefined),
    ).toBe("probe");
    expect(
      resolveSourceBenchmarkEvidenceMode(firefoxExperimental, "probe"),
    ).toBe("probe");
  });

  it("rejects ambient evidence modes that conflict with the project lane", () => {
    expect(() =>
      resolveSourceBenchmarkEvidenceMode(preflight, "required"),
    ).toThrow(/conflicts with chromium-preflight preflight lane/u);
    expect(() =>
      resolveSourceBenchmarkEvidenceMode(chrome, "probe"),
    ).toThrow(/conflicts with chrome-stable branded lane/u);
    expect(() =>
      resolveSourceBenchmarkEvidenceMode(chrome, "pass"),
    ).toThrow(/evidence mode must be either required or probe/u);
  });

  it("makes branded requiredness intrinsic and ambient policy monotonic", () => {
    expect(resolveWebGpuRequired(chrome, undefined)).toBe(true);
    expect(resolveWebGpuRequired(chrome, "0")).toBe(true);
    expect(resolveWebGpuRequired(preflight, undefined)).toBe(false);
    expect(resolveWebGpuRequired(preflight, "0")).toBe(false);
    expect(resolveWebGpuRequired(preflight, "1")).toBe(true);
    expect(
      resolveWebGpuRequired(
        { ...preflight, webgpuRequired: true },
        "0",
      ),
    ).toBe(true);
    expect(resolveWebGpuRequired(firefoxPreflight, "0")).toBe(true);
    expect(resolveWebGpuRequired(firefoxExperimental, "0")).toBe(false);
    expect(resolveWebGpuRequired(firefoxExperimental, "1")).toBe(true);
  });

  it("reads a complete, internally consistent executing-project identity", () => {
    expect(
      readForge3DBrowserProjectMetadata({
        forge3dBrowser: preflight,
      }),
    ).toEqual(preflight);
    expect(
      readForge3DBrowserProjectMetadata({
        forge3dBrowser: webkit,
      }),
    ).toEqual(webkit);
    expect(() =>
      readForge3DBrowserProjectMetadata({
        forge3dBrowser: {
          ...chrome,
          channel: "msedge",
        },
      }),
    ).toThrow(/project identity is inconsistent/u);
    expect(() =>
      readForge3DBrowserProjectMetadata({}),
    ).toThrow(/missing forge3dBrowser metadata/u);
    expect(
      readForge3DBrowserProjectMetadata({
        forge3dBrowser: firefoxPreflight,
      }),
    ).toEqual(firefoxPreflight);
    expect(
      readForge3DBrowserProjectMetadata({
        forge3dBrowser: firefoxExperimental,
      }),
    ).toEqual(firefoxExperimental);
  });

  it("cannot confuse default Firefox preflight with preference-enabled experimental evidence", () => {
    for (const malformed of [
      {
        ...firefoxPreflight,
        preferenceMode: "override",
        firefoxUserPrefs: { "dom.webgpu.enabled": true },
      },
      {
        ...firefoxPreflight,
        supportLevel: "NOT_PROVEN",
      },
      {
        ...firefoxPreflight,
        launchArgs: ["--enable-unsafe-webgpu"],
      },
      {
        ...firefoxExperimental,
        preferenceMode: "default",
        firefoxUserPrefs: {},
      },
      {
        ...firefoxExperimental,
        webgpuRequired: true,
      },
      {
        ...firefoxExperimental,
        launchArgs: ["--enable-unsafe-webgpu"],
      },
      {
        ...firefoxExperimental,
        firefoxUserPrefs: {
          "dom.webgpu.enabled": true,
          "some.other.preference": true,
        },
      },
    ]) {
      expect(() =>
        readForge3DBrowserProjectMetadata({
          forge3dBrowser: malformed,
        }),
      ).toThrow(/Firefox preference or support metadata is inconsistent/u);
    }
  });

  it("rejects Chromium launch proof or launch arguments for WebKit", () => {
    expect(() =>
      readForge3DBrowserProjectMetadata({
        forge3dBrowser: {
          ...webkit,
          launchObservation: "chromium-live",
        },
      }),
    ).toThrow(/project identity is inconsistent/u);
    expect(() =>
      readForge3DBrowserProjectMetadata({
        forge3dBrowser: {
          ...webkit,
          launchArgs: ["--enable-unsafe-webgpu"],
        },
      }),
    ).toThrow(/project identity is inconsistent/u);
  });

  it("reports configured and observed flag presence without hiding preflight", () => {
    const observed = [
      "--enable-automation",
      "--enable-unsafe-webgpu",
      "--use-angle=d3d11",
    ];
    expect(launchFlagPresence(preflight.launchArgs, observed)).toEqual({
      unsafeWebGpu: {
        configured: true,
        observed: true,
      },
      gpuBlocklistBypass: {
        configured: false,
        observed: false,
      },
      vulkanEnableOrForce: {
        configured: false,
        observed: false,
      },
      angleForce: {
        configured: true,
        observed: true,
      },
    });
    expect(
      configuredLaunchArgumentsObserved(
        preflight.launchArgs,
        observed,
      ),
    ).toBe(true);
    expect(
      preflightLaunchIdentityConsistent(
        preflight,
        preflight.launchArgs,
        observed,
      ),
    ).toBe(true);
    expect(
      preflightLaunchIdentityConsistent(
        chrome,
        [],
        ["--enable-unsafe-webgpu"],
      ),
    ).toBe(false);
  });

  it.each([
    ["unsafe WebGPU", "--enable-unsafe-webgpu", "unsafeWebGpu"],
    [
      "GPU blocklist bypass",
      "--ignore-gpu-blocklist",
      "gpuBlocklistBypass",
    ],
    [
      "Vulkan enable",
      "--enable-features=Vulkan",
      "vulkanEnableOrForce",
    ],
    ["Vulkan forcing", "--use-vulkan=native", "vulkanEnableOrForce"],
    ["ANGLE forcing", "--use-angle=gl", "angleForce"],
  ] as const)(
    "classifies %s and requires a visible preflight identity",
    (_name, argument, category) => {
      expect(launchFlagsPresent([argument])).toBe(true);
      expect(
        launchFlagPresence([argument], [argument])[category],
      ).toEqual({
        configured: true,
        observed: true,
      });
      expect(
        preflightLaunchIdentityConsistent(
          preflight,
          [argument],
          [argument],
        ),
      ).toBe(true);
      expect(
        preflightLaunchIdentityConsistent(chrome, [], [argument]),
      ).toBe(false);
    },
  );

  it.each([
    "--enable-features=CanvasOopRasterization",
    "--disable-gpu",
    "--disable-vulkan",
    "--angle",
  ])("does not classify unrelated launch argument %s", (argument) => {
    expect(launchFlagsPresent([argument])).toBe(false);
    expect(
      preflightLaunchIdentityConsistent(chrome, [], [argument]),
    ).toBe(true);
  });
});
