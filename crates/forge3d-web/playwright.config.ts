import {
  defineConfig,
  type PlaywrightTestProject,
} from "@playwright/test";

import type { Forge3DBrowserProjectMetadata } from "./tests/browser/playwright-project-metadata";

function browserMetadata(
  metadata: Forge3DBrowserProjectMetadata,
): { forge3dBrowser: Forge3DBrowserProjectMetadata } {
  return { forge3dBrowser: metadata };
}

export function createBrowserProjects(
  platform: string,
  architecture: string = process.arch,
): PlaywrightTestProject[] {
  const preflightLaunchArgs = [
    "--enable-unsafe-webgpu",
    ...(platform === "win32" ? ["--use-angle=d3d11"] : []),
  ];

  const projects: PlaywrightTestProject[] = [
    {
      name: "chromium-preflight",
      metadata: browserMetadata({
        project: "chromium-preflight",
        browserName: "chromium",
        channel: "playwright",
        lane: "preflight",
        webgpuRequired: true,
        launchArgs: [...preflightLaunchArgs],
      }),
      use: {
        browserName: "chromium",
        launchOptions: {
          args: preflightLaunchArgs,
        },
      },
    },
    {
      name: "chrome-stable",
      metadata: browserMetadata({
        project: "chrome-stable",
        browserName: "chrome",
        channel: "chrome",
        lane: "branded",
        webgpuRequired: true,
        launchArgs: [],
      }),
      use: {
        browserName: "chromium",
        channel: "chrome",
      },
    },
    {
      name: "edge-stable",
      metadata: browserMetadata({
        project: "edge-stable",
        browserName: "edge",
        channel: "msedge",
        lane: "branded",
        webgpuRequired: true,
        launchArgs: [],
      }),
      use: {
        browserName: "chromium",
        channel: "msedge",
      },
    },
    {
      name: "firefox-preflight",
      metadata: browserMetadata({
        project: "firefox-preflight",
        browserName: "firefox",
        channel: "playwright",
        lane: "preflight",
        webgpuRequired: true,
        launchArgs: [],
        preferenceMode: "default",
        firefoxUserPrefs: {},
        supportLevel: "ENGINE_PASS",
      }),
      use: {
        browserName: "firefox",
      },
    },
  ];

  if (
    platform === "linux" ||
    (platform === "darwin" && architecture === "x64")
  ) {
    projects.push({
      name: "firefox-nightly-experimental",
      metadata: browserMetadata({
        project: "firefox-nightly-experimental",
        browserName: "firefox",
        channel: "playwright",
        lane: "experimental",
        webgpuRequired: false,
        launchArgs: [],
        preferenceMode: "override",
        firefoxUserPrefs: {
          "dom.webgpu.enabled": true,
        },
        supportLevel: "NOT_PROVEN",
      }),
      use: {
        browserName: "firefox",
        launchOptions: {
          firefoxUserPrefs: {
            "dom.webgpu.enabled": true,
          },
        },
      },
    });
  }

  return projects;
}

export default defineConfig({
  testDir: "tests/playwright",
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:57883/examples/test-clear.html",
    reuseExistingServer: false,
    timeout: 120_000
  },
  use: {
    baseURL: "http://127.0.0.1:57883",
    headless: process.env.FORGE3D_HEADED !== "1"
  },
  projects: createBrowserProjects(process.platform, process.arch)
});
