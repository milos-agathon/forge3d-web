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
): PlaywrightTestProject[] {
  const preflightLaunchArgs = [
    "--enable-unsafe-webgpu",
    ...(platform === "win32" ? ["--use-angle=d3d11"] : []),
  ];

  return [
    {
      name: "chromium-preflight",
      metadata: browserMetadata({
        project: "chromium-preflight",
        browserName: "chromium",
        channel: "playwright",
        lane: "preflight",
        launchObservation: "chromium-live",
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
        launchObservation: "chromium-live",
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
        launchObservation: "chromium-live",
        webgpuRequired: true,
        launchArgs: [],
      }),
      use: {
        browserName: "chromium",
        channel: "msedge",
      },
    },
    {
      name: "webkit-preflight",
      metadata: browserMetadata({
        project: "webkit-preflight",
        browserName: "webkit",
        channel: "playwright",
        lane: "preflight",
        launchObservation: "project-configuration",
        webgpuRequired: true,
        launchArgs: [],
      }),
      use: {
        browserName: "webkit",
      },
    },
  ];
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
  projects: createBrowserProjects(process.platform)
});
