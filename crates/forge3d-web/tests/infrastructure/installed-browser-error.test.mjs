import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Execute the actual gate with browser loading failure, before viewer creation.
const source = readFileSync(new URL("../../scripts/build-browser-test-package.mjs", import.meta.url), "utf8");
const gateSource = source.slice(source.indexOf("async function runInstalledPackageBrowserGate("), source.indexOf("\nfunction run(command,"));
test("installed gate retains module errors when viewer creation fails early", async () => {
  const handlers = new Map();
  let evaluations = 0, closed = false;
  const page = {
    on(name, callback) { handlers.set(name, callback); },
    async goto() { handlers.get("pageerror")(new Error("module import failed: missing export")); },
    async evaluate() {
      if (++evaluations === 1) return { available: true, fallback: false };
      throw new Error("Cannot read properties of undefined (reading 'create')");
    },
  };
  const chromium = { async launch() { return { async newPage() { return page; }, async close() { closed = true; } }; } };
  const gate = new Function("chromium", "VIEWER_INTERACTION_ERROR_KEY", `${gateSource}; return runInstalledPackageBrowserGate;`)(chromium, "errors");
  await assert.rejects(gate("http://fixture", "sha", "commit", false, { playwrightChannel: null, launchArguments: [], lane: "required" }), /module import failed: missing export/);
  assert.equal(closed, true);
});
