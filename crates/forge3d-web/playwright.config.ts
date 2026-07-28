import { defineConfig } from "@playwright/test";

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
    headless: process.env.FORGE3D_HEADED !== "1",
    launchOptions: {
      args: [
        "--enable-unsafe-webgpu",
        ...(process.platform === "win32" ? ["--use-angle=d3d11"] : []),
      ]
    }
  },
  projects: [
    {
      name: "chrome",
      use: { channel: "chrome" }
    }
  ]
});
