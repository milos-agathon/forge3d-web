import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["tests/unit/license-setup.ts"],
    include: ["tests/unit/**/*.test.ts"],
  },
});
