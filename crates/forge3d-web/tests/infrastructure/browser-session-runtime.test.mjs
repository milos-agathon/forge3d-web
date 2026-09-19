import assert from "node:assert/strict";
import test from "node:test";

import { closePlaywright, runWebDriverPage } from "../../scripts/browser-session-runtime.mjs";

test("Playwright cleanup closes context before browser", async () => {
  const calls = [];
  await closePlaywright(
    { close: async () => calls.push("context") },
    { close: async () => calls.push("browser") },
  );
  assert.deepEqual(calls, ["context", "browser"]);
});

test("Playwright cleanup still closes browser when context close fails", async () => {
  const calls = [];
  await assert.rejects(() => closePlaywright(
    { close: async () => { calls.push("context"); throw new Error("context close failed"); } },
    { close: async () => calls.push("browser") },
  ), /context close failed/u);
  assert.deepEqual(calls, ["context", "browser"]);
});

test("Playwright cleanup retains both nested close failures", async () => {
  await assert.rejects(() => closePlaywright(
    { close: async () => { throw new Error("context"); } },
    { close: async () => { throw new Error("browser"); } },
  ), (error) => error instanceof AggregateError && error.errors.length === 2);
});

test("Safari WebDriver routes only the automated Safari lane to SAF-04 acceptance", async () => {
  const calls = [];
  const session = {
    runHardwarePage: async (payload) => { calls.push(payload); return "manual"; },
  };
  assert.equal(await runWebDriverPage({
    runtime: { driver: "safaridriver" }, session,
    payload: { binding: { lane: "manual-safari-trackpad" } },
  }), "manual");
  assert.equal(calls.length, 1);
  await assert.rejects(() => runWebDriverPage({
    runtime: { driver: "safaridriver" },
    session: { runHardwarePage: async () => ({ assertions: { passed: true } }) },
    payload: { binding: { lane: "safari-macos-m2" } },
  }), /executeAsync/u);
});

test("non-Safari WebDriver remains on the generic hardware page", async () => {
  const session = { runHardwarePage: async () => "generic" };
  assert.equal(await runWebDriverPage({
    runtime: { driver: "selenium-firefox" }, session,
    payload: { binding: { lane: "safari-macos-m2" } },
  }), "generic");
});
