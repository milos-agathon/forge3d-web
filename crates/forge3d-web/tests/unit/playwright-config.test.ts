import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import config, { createBrowserProjects } from "../../playwright.config";

function projectNamed(
  projects: ReturnType<typeof createBrowserProjects>,
  name: string,
) {
  const project = projects.find((candidate) => candidate.name === name);
  expect(project, `missing Playwright project ${name}`).toBeDefined();
  return project!;
}

describe("Playwright browser project configuration", () => {
  it.each([
    ["win32", "x64", false],
    ["darwin", "arm64", false],
    ["darwin", "x64", true],
    ["linux", "x64", true],
    ["linux", "arm64", true],
  ] as const)(
    "keeps launch flags and Firefox preferences scoped on %s/%s",
    (platform, architecture, hasExperimentalFirefox) => {
      const projects = createBrowserProjects(platform, architecture);
      const expectedProjects = [
        "chromium-preflight",
        "chrome-stable",
        "edge-stable",
        "firefox-preflight",
        "webkit-preflight",
      ];
      if (hasExperimentalFirefox) {
        expectedProjects.push("firefox-nightly-experimental");
      }
      expect(projects.map(({ name }) => name)).toEqual(expectedProjects);

      const preflight = projectNamed(projects, "chromium-preflight");
      const expectedArgs = [
        "--enable-unsafe-webgpu",
        ...(platform === "win32" ? ["--use-angle=d3d11"] : []),
      ];
      expect(preflight.use?.launchOptions?.args).toEqual(expectedArgs);
      expect(preflight.metadata?.forge3dBrowser).toEqual({
        project: preflight.name,
        browserName: "chromium",
        channel: "playwright",
        lane: "preflight",
        launchObservation: "chromium-live",
        webgpuRequired: true,
        launchArgs: expectedArgs,
      });

      const chrome = projectNamed(projects, "chrome-stable");
      expect(chrome.use).toEqual({
        browserName: "chromium",
        channel: "chrome",
      });
      expect(chrome.use).not.toHaveProperty("launchOptions");
      expect(chrome.metadata?.forge3dBrowser).toEqual({
        project: chrome.name,
        browserName: "chrome",
        channel: "chrome",
        lane: "branded",
        launchObservation: "chromium-live",
        webgpuRequired: true,
        launchArgs: [],
      });

      const edge = projectNamed(projects, "edge-stable");
      expect(edge.use).toEqual({
        browserName: "chromium",
        channel: "msedge",
      });
      expect(edge.use).not.toHaveProperty("launchOptions");
      expect(edge.metadata?.forge3dBrowser).toEqual({
        project: edge.name,
        browserName: "edge",
        channel: "msedge",
        lane: "branded",
        launchObservation: "chromium-live",
        webgpuRequired: true,
        launchArgs: [],
      });

      const webkit = projectNamed(projects, "webkit-preflight");
      expect(webkit.use).toEqual({
        browserName: "webkit",
      });
      expect(webkit.use).not.toHaveProperty("launchOptions");
      expect(webkit.metadata?.forge3dBrowser).toEqual({
        project: webkit.name,
        browserName: "webkit",
        channel: "playwright",
        lane: "preflight",
        launchObservation: "project-configuration",
        webgpuRequired: true,
        launchArgs: [],
      });

      const firefox = projectNamed(projects, "firefox-preflight");
      expect(firefox.use).toEqual({
        browserName: "firefox",
      });
      expect(firefox.use).not.toHaveProperty("launchOptions");
      expect(firefox.metadata?.forge3dBrowser).toEqual({
        project: firefox.name,
        browserName: "firefox",
        channel: "playwright",
        lane: "preflight",
        launchObservation: "project-configuration",
        webgpuRequired: true,
        launchArgs: [],
        preferenceMode: "default",
        firefoxUserPrefs: {},
        supportLevel: "ENGINE_PASS",
      });

      const experimental = projects.find(
        ({ name }) => name === "firefox-nightly-experimental",
      );
      if (!hasExperimentalFirefox) {
        expect(experimental).toBeUndefined();
        return;
      }
      expect(experimental?.use).toEqual({
        browserName: "firefox",
        launchOptions: {
          firefoxUserPrefs: {
            "dom.webgpu.enabled": true,
          },
        },
      });
      expect(experimental?.use?.launchOptions).not.toHaveProperty("args");
      expect(experimental?.metadata?.forge3dBrowser).toEqual({
        project: experimental?.name,
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
      });
    },
  );

  it("preserves shared launch behavior without global browser flags", () => {
    expect(config.use).toMatchObject({
      baseURL: "http://127.0.0.1:57883",
      headless: process.env.FORGE3D_HEADED !== "1",
    });
    expect(config.use).not.toHaveProperty("launchOptions");
    expect(config.webServer).toEqual({
      command: "npm run dev",
      url: "http://127.0.0.1:57883/examples/test-clear.html",
      reuseExistingServer: false,
      timeout: 120_000,
    });
  });

  it("selects one exact project in each browser script", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { scripts: Record<string, string> };

    expect(packageJson.scripts).toMatchObject({
      "test:browser": "playwright test --project=chromium-preflight",
      "test:browser:chromium":
        "playwright test --project=chromium-preflight",
      "test:browser:chrome": "playwright test --project=chrome-stable",
      "test:browser:edge": "playwright test --project=edge-stable",
      "test:browser:firefox-preflight":
        "playwright test --project=firefox-preflight",
      "test:browser:webkit":
        "playwright test --project=webkit-preflight",
    });
    expect(packageJson.scripts).not.toHaveProperty(
      "test:browser:firefox-nightly-experimental",
    );
  });
});
