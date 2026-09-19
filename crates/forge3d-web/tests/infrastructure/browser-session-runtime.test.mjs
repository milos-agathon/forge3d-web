import assert from "node:assert/strict";
import test from "node:test";

import { closePlaywright } from "../../scripts/browser-session-runtime.mjs";

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
