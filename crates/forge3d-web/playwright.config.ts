import { defineConfig, devices } from "@playwright/test";

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
    launchOptions: {
      args: ["--enable-unsafe-webgpu", "--use-angle=d3d11"]
    }
  },
  projects: [
    {
      name: "chrome",
      use: { ...devices["Desktop Chrome"], channel: "chrome" }
    }
  ]
});
